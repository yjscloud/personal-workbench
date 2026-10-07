/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 用 rgb(var(--x-rgb) / <alpha-value>) 形式定义，
        // 这样 bg-panel/35、border-accent/45 这类透明度修饰才能正确生成
        bg: 'rgb(var(--bg-rgb) / <alpha-value>)',
        'bg-2': 'rgb(var(--bg-2-rgb) / <alpha-value>)',
        'bg-3': 'rgb(var(--bg-3-rgb) / <alpha-value>)',
        panel: 'rgb(var(--panel-rgb) / <alpha-value>)',
        'panel-2': 'rgb(var(--panel-2-rgb) / <alpha-value>)',
        line: 'rgb(var(--line-rgb) / <alpha-value>)',
        'line-2': 'rgb(var(--line-2-rgb) / <alpha-value>)',
        'line-strong': 'rgb(var(--line-strong-rgb) / <alpha-value>)',
        ink: 'rgb(var(--text-rgb) / <alpha-value>)',
        muted: 'rgb(var(--muted-rgb) / <alpha-value>)',
        faint: 'rgb(var(--faint-rgb) / <alpha-value>)',
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        'accent-hover': 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
        'on-accent': 'rgb(var(--on-accent-rgb) / <alpha-value>)',
        // 压在 bg-ok 实心块上的前景色（不需要透明度修饰，直接用具体值）
        'on-ok': 'var(--on-ok)',
        signal: 'rgb(var(--accent-2-rgb) / <alpha-value>)',
        ok: 'rgb(var(--ok-rgb) / <alpha-value>)',
        warn: 'rgb(var(--warn-rgb) / <alpha-value>)',
        crit: 'rgb(var(--crit-rgb) / <alpha-value>)',
        // soft 变体本身已是具体色值，直接引用
        'accent-soft': 'var(--accent-soft)',
        'signal-soft': 'var(--accent-2-soft)',
        'ok-soft': 'var(--ok-soft)',
        'warn-soft': 'var(--warn-soft)',
        'crit-soft': 'var(--crit-soft)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Carbon 式的紧凑标签档
        '2xs': ['0.75rem', { lineHeight: '1rem' }],
        '3xs': ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.02em' }],
      },
      letterSpacing: {
        tightest: '-0.03em',
        display: '-0.02em',
      },
      /* 圆角只有这几档，不要再写 rounded-md / rounded-lg / rounded-[7px] 这类近似值 ——
         同一层级同时用几个差 2px 的值，正是"看着像设计过、其实没有规则"的来源。
         定义集中在这里，改一处全站生效：
           xl2   16px  容器：卡片 / 面板 / 弹窗
           field 10px  控件与内容块：按钮 / 输入框 / 列表项 / 缩略图 / 图标方块
           xs     4px  小方标记：24px 以下的勾选框。这一档不能省 ——
                       10px 在 15~18px 的方块上会被钳成圆，而圆会被读成单选
           full        圆：标签 / 徽章 / 状态点
         （旧注释写的是"容器一律方角"，与实际 26 处 rounded-xl2 相反，已更正。） */
      borderRadius: {
        xl2: '1rem',
        field: '0.625rem',
        xs: '0.25rem',
      },

      /* 网格列数只多给一档：13。首页「常用网站」的方形磁贴要排到 13 列
         —— 12 列在 1440px 下每张还有 102px，仍偏大；而写成
         grid-cols-[13fr] 得在类名里塞方括号，那串字符在编辑工具、shell
         与代码审查里一路都要转义。这里登记一个正经档位。 */
      gridTemplateColumns: {
        13: 'repeat(13, minmax(0, 1fr))',
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        soft: 'var(--shadow-soft)',
        pop: 'var(--shadow-pop)',
        /* 抬起来的那一档。补这一档是因为它一直缺着：
           --shadow-lift 在 index.css 里有定义，却从没接成工具类，于是
           · shadow-lift / hover:shadow-lift 全是死类，写了等于没写；
           · shadow-[var(--shadow-lift)] 又被 Tailwind 判成"阴影颜色"，
             生成的是 --tw-shadow-color，同样什么都没画。
           唯一想用它的是登录卡，卡片因此一直只有默认的 panel 投影。 */
        lift: 'var(--shadow-lift)',
        // 只保留一个聚焦环
        focus: '0 0 0 2px var(--bg), 0 0 0 4px var(--accent)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-rise': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(24px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        // 居中弹窗：比抽屉多一个极轻的缩放，读起来才像"浮起来"而不是"滑进来"
        'dialog-in': {
          from: { opacity: '0', transform: 'translateY(10px) scale(0.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-rise': 'fade-rise 0.2s cubic-bezier(0.22, 1, 0.36, 1) both',
        'slide-in-right': 'slide-in-right 0.22s cubic-bezier(0.22, 1, 0.36, 1) both',
        'dialog-in': 'dialog-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [],
};
