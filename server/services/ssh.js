import { execFile } from 'node:child_process';

/* ────────────────────────────────────────────────────────────────────────
 * 到 PVE 母机执行命令的通道
 *
 * PVE 的 API 覆盖不到很多东西（改 governor、读完整 SMART 属性都只能上机执行），
 * 所以这条 SSH 是若干个功能的共同底座。放在一个文件里，配置只解析一次，
 * 免得每个调用方各写一份、各错一次。
 *
 * 安全约束：远端命令全程用 execFile + 参数数组下发，不经本地 shell，
 * 主机名/设备名里的字符不会被本地解释。
 *
 * 注意：命令仍然会被**远端** shell 解释，所以调用方拼进命令的
 * 设备名之类参数必须先过白名单校验（见 smart.js 的 safeDev）。
 * ──────────────────────────────────────────────────────────────────────── */

const SSH_USER = (process.env.PVE_SSH_USER || 'root').trim();
const SSH_KEY = (process.env.PVE_SSH_KEY || '/root/.ssh/id_rsa').trim();

/**
 * @param {string} host  PVE 母机地址
 * @param {string} command  远端命令
 * @returns {Promise<string>} 标准输出；非零退出码按失败处理
 */
export function sshRun(host, command, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [
        // 禁掉一切交互式提问：连不上就立刻失败，不要挂在密码提示上等超时
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-i', SSH_KEY,
        `${SSH_USER}@${host}`,
        command,
      ],
      {
        timeout,
        // systemd 单元里的 Environment= 是空的，HOME 不保证存在。
        // ssh 要靠 HOME 定位 known_hosts，缺了会直接报 "No such file or directory"，
        // 而且报错信息完全不提 HOME，很难查。这里显式兜底。
        env: { ...process.env, HOME: process.env.HOME || '/root' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || '').trim().split('\n')[0];
          return reject(new Error(msg || 'SSH 执行失败'));
        }
        resolve(String(stdout || '').trim());
      },
    );
  });
}
