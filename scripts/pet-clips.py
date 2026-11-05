#!/usr/bin/env python3
"""桌宠「小动作」素材接入：上游 webm → `src/assets/pet/extra/<key>.webm` + 首帧 webp。

    python3 scripts/pet-clips.py            # 只补缺的
    python3 scripts/pet-clips.py --force    # 全部重下
    python3 scripts/pet-clips.py --check    # 只报告，不落盘

素材来自 https://github.com/PC2005-cloud/dsh-pet （代码 MIT，动画素材 CC BY-NC-SA 4.0）。
上游 `dsh-pet/assets/webm/` 一共 109 段，文件名是中文。这里接 **77 段**，排掉 32 段：

  · 余额-*（6）、工作状态-*（6）：业务状态，已经有专属姿势动画；
  · 待机呼吸休闲（和 idle 重复）、被鼠标拖拽悬空反馈（只在拖拽时成立）；
  · **18 段和 `clips/` 里的状态动画逐字节相同** —— 这是最坑的一类：
    换个名字、内容一帧不差，放进待机池等于"轮换到同一段"，看着就像没换。
    对照关系（extra ← clips）：
      nap←night       sleeploop←sleep   tickle←pat      wavecheer←wave
      shysurprise←shy  joyhop←plush     snowman←winter  bloom←love
      spin←star       lion←streak       dove←surprise   float←swim
      squash←drag     token←feed        gift←gift       curtsy←checkin
      lantern←celebrate
    用 md5 一比就能发现，别只按文件名判断。

    唯一的例外是 **brush←morning**：`morning` 那段素材就是"晨间刷牙"，
    原先被钉在 6–11 点的待机姿势上，于是每放完一个小动作都回到刷牙。
    现在早间时段改用 idle ⇄ plush，刷牙退回成池子里的普通动作（一轮一次），
    所以它和 `clips/morning` 内容相同也没关系 —— 那段已经不作为待机出现了。

三件事，都不改画面内容：

1. **规格校验**：统一 640×360 / 24fps / VP9-alpha。视频层按固定比例贴进
   132px 的方形容器（见 PetClip.tsx 顶部），尺寸或帧率不一样，人物就会
   忽大忽小、换动作时跳一下。对不上就用 ffmpeg 重编码，绝不直接塞进去。
2. **去重下载**：原片缓存在 `.pet-src/webm/`（已在 .gitignore 里），
   重跑不会重复拉。
3. **首帧 webp**：320×320，按视频层的映射**预裁**成方形（crop 200,44,282,282），
   和 `frames/` 那批同一个规则。视频还没解出来时先铺它，切换不会空白。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from fractions import Fraction

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.pet-src/webm')
DST = os.path.join(ROOT, 'src/assets/pet/extra')
BASE = 'https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/webm'

W, H, FPS = 640, 360, 24
# 与 PetClip 的 CLIP_STAGE 对应：方形容器 320 时，视频显示 726.4×408.6，
# 左边 -227.5、上边 -50.5；把这块反算回 640×360 就是下面这个正方形
CROP = (200, 44, 282, 282)
FRAME = 320

# key（文件名/动作 id） → 上游中文名。key 只用小写字母：PetWhale 的 byKey 用 [a-z]+ 解析。
# 顺序与 `src/lib/pet-roam.ts` 的 ROAM_GROUPS 一致，改一边记得改另一边。
JOBS: dict[str, str] = {
    # 日常
    'look': '东张西望',
    'cat': '撸猫',
    'code': '写代码',
    'cube': '原地专心玩魔方',
    'gomoku': '下五子棋',
    'juggle': '三球抛接',
    'top': '抽陀螺',
    'shuttle': '踢毽子',
    'swing': '荡秋千',
    'hobby': '骑木马',
    'crab': '螃蟹走路',
    'taptable': '原地敲击桌面互动',
    'jumpgrab': '原地跳跃抓碎头顶物品',
    'toycar': '原地蹲下玩玩具汽车',
    'run': '原地左转奔跑',
    'tailslap': '用鲸鱼尾巴拍打地面',
    'whattoeat': '是啊，吃什么',

    # 才艺
    'hum': '悠闲哼歌',
    'dance': '可爱宅舞',
    'sway': '轻快摇摆舞',
    'violin': '小提琴演奏',
    'flute': '吹笛子',
    'magic': '扑克魔术',
    'balloon': '吹气球',
    'butterfly': '蝴蝶蜜蜂环绕头顶开花',
    'bubbles': '鲸鱼吐泡泡特效',
    'maidance': '优雅女仆舞',
    'needle': '穿针乞巧',

    # 吃喝
    'snack': '偷吃零食被抓住',
    'icecream': '吃冰淇淋融化',
    'rice': '吃白饭',
    'hotpot': '涮火锅',
    'munch': '大口吃零食',
    'lunch': '吃午餐',
    'breakfast': '吃早餐',
    'dinner': '吃晚餐',
    'tangyuan': '吃汤圆',
    'zongzi': '吃粽子',
    'niangao': '吃年糕',
    'candied': '吃糖葫芦',
    'congee': '吃腊八粥',
    'watermelon': '吃西瓜',
    'chongyang': '吃重阳糕',
    'noodles': '吃长寿面',
    'qingtuan': '吃青团',
    'dumpling': '吃饺子',
    'crabmeal': '吃大闸蟹',

    # 休整
    'brush': '晨间刷牙',
    'doze': '打瞌睡被惊醒',
    'yawn': '哈欠连天',
    'stretch': '超大伸懒腰',
    'mirror': '照镜子',
    'fan': '摇扇纳凉',
    'sleepstart': '睡觉-开始',
    'sleepwake': '睡觉-起来',

    # 玩乐
    'kite': '放风筝',
    'watergun': '玩水枪',
    'redpacket': '收红包',
    'outfit': '整体换装试色',
    'xmas': '装点圣诞树',
    'pumpkin': '讨糖南瓜灯',
    'leaves': '被落叶淹没',
    'startled': '被吓一跳',
    'ghost': '萌化小幽灵',
    'bigwhale': '蓝鲸现世',
    'animals': '动物环绕',
    'rage': '玩游戏气急败坏',

    # 节日
    'riverlantern': '放河灯',
    'fireworks': '放烟花',
    'mooncake': '中秋赏月吃月饼',
    'fuzi': '写福字',
    'chrysanth': '插茱萸赏菊',

    # 碎碎念
    'deepthink': '深度思考碎碎念',
    'dazedbuzz': '碎碎念-发呆碎碎念',
    'screenbuzz': '碎碎念-对屏碎碎念',
    'wipebuzz': '碎碎念-擦桌碎碎念',
    'noting': '轻快记录',

    # 点击回应
    'tsundere': '点击回应-傲娇生气',
}


def probe(path: str) -> tuple[int, int, str] | None:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', path],
        capture_output=True, text=True,
    ).stdout.strip()
    if not out:
        return None
    w, h, fps = (out.split(',') + ['', ''])[:3]
    return int(w), int(h), fps


def fps_eq(raw: str, want: int) -> bool:
    """ffprobe 给的是 `24/1`，直接和 `24` 比会误判成"要重编码"，白涨一倍体积。"""
    try:
        return Fraction(raw) == want
    except (ValueError, ZeroDivisionError):
        return False


def alpha_missing(path: str) -> bool:
    """没有 alpha 平面就等于一块黑方块，宁可报错也不要它。"""
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream_tags=alpha_mode', '-of', 'csv=p=0', path],
        capture_output=True, text=True,
    ).stdout.strip()
    return out != '1'


def download(name: str) -> str:
    os.makedirs(CACHE, exist_ok=True)
    dst = os.path.join(CACHE, f'{name}.webm')
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return dst
    url = f'{BASE}/{urllib.parse.quote(name)}.webm'
    print(f'  ↓ {name}')
    with urllib.request.urlopen(url, timeout=90) as r, open(dst, 'wb') as f:
        shutil.copyfileobj(r, f)
    return dst


def transcode(src: str, dst: str) -> None:
    """规格不对时兜底重编码。透明背景必须 yuva420p + -auto-alt-ref 0。"""
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', src,
        '-vf', f'scale={W}:{H}:force_original_aspect_ratio=decrease,'
               f'pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1',
        '-r', str(FPS), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
        '-auto-alt-ref', '0', '-b:v', '0', '-crf', '34',
        '-deadline', 'good', '-cpu-used', '3', dst,
    ], check=True)


def first_frame(src: str, dst: str) -> None:
    """第 0 帧按视频层映射预裁成 320×320。libvpx 解码器才读得出 alpha 平面。"""
    tmp = dst + '.png'
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', src,
        '-vf', f'crop={CROP[2]}:{CROP[3]}:{CROP[0]}:{CROP[1]},scale={FRAME}:{FRAME}:flags=lanczos',
        '-frames:v', '1', '-pix_fmt', 'rgba', tmp,
    ], check=True)
    im = Image.open(tmp).convert('RGBA')
    im.save(dst, format='WEBP', quality=88, method=6)
    os.remove(tmp)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='已存在的也重下')
    ap.add_argument('--check', action='store_true', help='只校验，不写文件')
    args = ap.parse_args()

    os.makedirs(DST, exist_ok=True)
    done = skipped = failed = 0
    for key, name in JOBS.items():
        out = os.path.join(DST, f'{key}.webm')
        if os.path.exists(out) and not args.force:
            skipped += 1
            continue
        try:
            src = download(name)
        except Exception as e:  # 网络问题不该让整批中断
            print(f'  !! {key}: 下载失败 {e}')
            failed += 1
            continue

        info = probe(src)
        if not info:
            print(f'  !! {key}: 读不出视频流')
            failed += 1
            continue
        w, h, fps = info
        if alpha_missing(src):
            print(f'  !! {key}: 没有 alpha 平面，跳过')
            failed += 1
            continue

        if args.check:
            print(f'  {key:10s} {w}x{h}@{fps}  {os.path.getsize(src) // 1024}KB')
            done += 1
            continue

        if (w, h) == (W, H) and fps_eq(fps, FPS):
            shutil.copyfile(src, out)
        else:
            print(f'  ~ {key}: {w}x{h}@{fps} → {W}x{H}@{FPS}（重编码）')
            transcode(src, out)
        first_frame(out, os.path.join(DST, f'{key}.webp'))
        print(f'  ✓ {key:10s} {os.path.getsize(out) // 1024}KB')
        done += 1

    total = len(JOBS)
    print(f'\n新接入 {done}，已存在 {skipped}，失败 {failed}（共 {total} 段）')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
