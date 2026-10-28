#!/usr/bin/env python3
"""桌宠立绘归一化：白底 → 透明 → 裁到主体 → 统一尺寸 → 脚踩同一条底线。

    python3 scripts/pet-normalize.py                     # .pet-src/raw → states/
    python3 scripts/pet-normalize.py --check             # 只报告，不落盘

    `--src` 默认是 `.pet-src/raw`：原图一张 1.5MB、24 张 30MB 级，而且都能
    按提示词重出，所以按 .gitignore 的约定不入库（角色描述见 PetWhale.tsx 顶部）。

为什么需要它：出图模型给的是**白底、构图各异**的方图，而桌宠要的是
24 张换着播还认得出是同一个人的序列图。单看一张都没问题，一换姿势就
会忽大忽小、忽左忽右 —— 那点漂移在 132px 的小身板上特别明显。

三步：

1. **去白底**。不能简单地"白像素 → 透明"：围裙、蕾丝、衬衫全是白的，
   一并抹掉人就被掏空了。所以只抹**与画布边缘连通**的那一片白，靠
   `scipy.ndimage.label` 找连通域；被角色围住的白色（围裙）不算背景。
   边缘的过渡像素按"离白底多远"给半透明 alpha，再把白色从颜色里除掉
   （un-premultiply），否则缩到 132px 会留一圈灰边。

2. **统一比例**。按主体高度缩放到画布 94%，宽度超了就改按宽度收 ——
   躺着的睡姿是横着的，只按高度放大会撑出画布。

3. **脚踩同一条底线**。横向不按外接框居中：鲸尾、举起的手都在侧面，
   按外接框居中会把**人**推偏。改成取底部 12% 那一条的 alpha 重心
   （就是两只脚的位置），让脚心落在画布中线。

文件名靠提示词开头的 `【05-night】` 认档位（出图工具会把【】和 `-` 洗成
`_05_night_`，所以这里按 `\d{2}[-_]pose` 取）。这也是**姿势码必须写在提示词
最前面**的原因：并行出图落在同一秒时，文件名是提示词前缀，长提示词只差结尾
就全撞在一起、后一张把前一张覆盖掉，还不报错。
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

SIZE = 512
FILL = 0.94  # 主体高度占画布的比例，与旧版一致
BG_TOL = 20  # 与白底的色差小于它就算"白"
EDGE_LO, EDGE_HI = 8, 30  # 半透明过渡带
FEET_BAND = 0.12  # 底部多少算"脚那一条"


def cut_background(im: Image.Image) -> Image.Image:
    rgb = np.asarray(im.convert('RGB'), dtype=np.float32)
    h, w, _ = rgb.shape

    border = np.concatenate([rgb[0, :], rgb[-1, :], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)

    # 与白底的"最大单通道差"：比欧氏距离保守，浅灰阴影也留得住
    dist = np.abs(rgb - bg).max(axis=2)
    near = dist < BG_TOL

    # 只有和画布边缘连成一片的白才算背景；围裙那种被角色围住的白留着
    labels, _ = ndimage.label(near)
    edge_ids = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
    edge_ids.discard(0)
    outside = np.isin(labels, list(edge_ids))

    alpha = np.where(outside, np.clip((dist - EDGE_LO) / (EDGE_HI - EDGE_LO), 0.0, 1.0), 1.0)
    alpha[alpha < 0.04] = 0.0

    # 边缘像素原本是"角色色 + 白底"的混合，把白底那部分减回去，免得缩图后发灰
    a = alpha[..., None]
    straight = np.where(a > 0.05, (rgb - bg * (1.0 - a)) / np.maximum(a, 1e-6), rgb)
    out = np.concatenate([np.clip(straight, 0, 255), alpha[..., None] * 255], axis=2).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def feet_center(alpha: np.ndarray) -> float:
    """底部那一条的 alpha 重心 —— 也就是两只脚站的地方。"""
    h = alpha.shape[0]
    band = alpha[int(h * (1 - FEET_BAND)):].astype(np.float32)
    col = band.sum(axis=0)
    if col.sum() <= 0:
        return alpha.shape[1] / 2
    return float((col * np.arange(len(col))).sum() / col.sum())


def normalize(im: Image.Image) -> Image.Image:
    im = im.crop(im.split()[3].getbbox())
    bw, bh = im.size

    scale = min(SIZE * FILL / bh, SIZE * 0.98 / bw)
    w, h = max(1, round(bw * scale)), max(1, round(bh * scale))
    im = im.resize((w, h), Image.LANCZOS)

    alpha = np.asarray(im.split()[3], dtype=np.float32) / 255.0
    cx = feet_center(alpha)  # 缩放后的像素坐标
    x = int(round(SIZE / 2 - cx))
    x = min(max(x, 0), SIZE - w)  # 尾巴甩出画布就退回来，宁可偏一点也不切图

    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(im, (x, SIZE - h), im)
    return canvas


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(root, '.pet-src/raw'))
    ap.add_argument('--dst', default=os.path.join(root, 'src/assets/pet/states'))
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.src, '*.png')))
    if not files:
        print(f'没有待处理的图：{args.src}')
        return 1

    seen: dict[str, str] = {}
    for path in files:
        # 出图工具会把【】和连字符吃掉，落到文件名里的是 02_plush 这种形式
        m = re.search(r'(?<!\d)(\d{2})[-_]([a-z]+)', os.path.basename(path))
        if not m:
            print(f'跳过（文件名里没有 NN-pose）: {os.path.basename(path)}')
            continue
        name = f'{m.group(1)}-{m.group(2)}.png'
        if name in seen:
            print(f'!! 撞名 {name}: {seen[name]} / {path}')
            continue
        seen[name] = path

        out = normalize(cut_background(Image.open(path)))
        bbox = out.split()[3].getbbox()
        print(f'{name:18s} bbox={bbox}')
        if not args.check:
            out.save(os.path.join(args.dst, name))

    missing = 24 - len(seen)
    print(f'\n处理 {len(seen)} 张' + (f'，还差 {missing} 张' if missing else '，24 张齐了'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
