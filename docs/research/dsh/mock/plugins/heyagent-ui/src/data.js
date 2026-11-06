// Static mock data for the HeyAgent panels (no backend).

export const INBOX = [
  {
    id: 'A-1043', kind: 'approval', kindLabel: '审批', title: '对外发询价：义乌乐享杯业', run: 'R-1106-3', task: '每日比价',
    who: '张伟（主管）', age: '3 分钟', state: 'pending',
    summary: '规则「对外发询价要主管批准」拦下了 agent 的「发送询价」。批准后运行从这一步继续。',
    fields: [
      ['规则', '对外发询价要主管批准（R-07）'],
      ['运行', 'R-1106-3 · 每日比价 · 等人处理'],
      ['供应商', '义乌乐享杯业（1688 诚信通 6 年）'],
      ['询价内容', '不锈钢保温杯 500ml × 500 个，目标单价 ≤ ¥9.50，含 logo 激光雕刻，11 月 20 日前到义乌仓'],
      ['agent 的理由', '综合价格、起订量、回头率排第一；48 小时发货'],
    ],
    actions: ['批准', '驳回', '改了再批'],
  },
  {
    id: 'L-88', kind: 'login', kindLabel: '登录', title: '1688 要登录：buyer01', run: 'R-1106-3', task: '每日比价',
    who: '采购组', age: '1 分钟', state: 'pending', browser: true,
    summary: '看供应商联系方式要先登录。接手浏览器，在远程画面里登录，然后点「已处理好了」。',
    fields: [
      ['浏览器', '采购-1（保留到 10:45）'],
      ['账号', 'buyer01 · 密码在保险箱'],
      ['页面', 'https://login.1688.com/member/signin.htm'],
    ],
    actions: ['接手浏览器', '已处理好了', '不登录，跳过'],
  },
  {
    id: 'C-212', kind: 'captcha', kindLabel: '验证码', title: '拼多多滑块验证', run: 'R-1106-1', task: '竞品价格监控',
    who: '运营组', age: '9 分钟', state: 'pending', browser: true,
    summary: 'agent 自己试了 2 次没过。请在远程画面里拖一下滑块。',
    fields: [['浏览器', '运营-2'], ['页面', 'mobile.yangkeduo.com'], ['已自动重试', '2 次']],
    actions: ['接手浏览器', '已处理好了'],
  },
  {
    id: 'Q-17', kind: 'question', kindLabel: '回答', title: '报价要不要含税？', run: 'R-1105-7', task: '供应商对账',
    who: '李娜', age: '22 分钟', state: 'pending',
    summary: 'agent 不确定对账单里的单价是否要按含税价核对。',
    fields: [['问题', '供应商 永康华美 的报价单写的是不含税价，对账单按含税价核，还是按不含税价核？'], ['选项', '含税 13% / 不含税 / 都列出来']],
    actions: ['回答'],
  },
  {
    id: 'V-9', kind: 'verify', kindLabel: '验收待定', title: '新品上架检查：3 项拿不准', run: 'R-1104-2', task: '新品上架检查',
    who: '王芳', age: '2 小时', state: 'pending',
    summary: '三方验收对 3 个检查项没把握，请人判定办成还是没办成。',
    fields: [['拿不准的项', '主图是否有水印 · 尺码表是否完整 · 运费模板'], ['截图', '6 张（在运行空间）']],
    actions: ['算办成', '算没办成', '打开运行'],
  },
  {
    id: 'A-1039', kind: 'approval', kindLabel: '审批', title: '付款申请 ¥3,860', run: 'R-1105-2', task: '供应商对账',
    who: '张伟（主管）', age: '昨天', state: 'done', result: '已批准 · 张伟',
    summary: '对账完成后生成的付款申请。', fields: [['金额', '¥3,860.00'], ['收款方', '浙江顺发日用品']], actions: [],
  },
]

export const TASKS = [
  {
    id: 'T-12', name: '每日比价', category: '采购', owner: '张伟', enabled: true, schedule: '工作日 09:00', next: '明天 09:00',
    runs: '今天 3 次 · 办成 2 · 等人 1', model: 'HeyAgent 规划模型',
    goal: '在 1688 找指定品类的前 20 个商品，比价格、起订量、回头率，挑 3 家发询价，交一张比价表。',
    steps: ['打开 1688 搜索任务参数里的关键词', '读前 20 个商品的价格、起订量、回头率', '排除回头率 < 20% 的', '给综合前 3 名发询价（要审批）', '写比价表交付'],
    checkpoints: ['找到至少 3 家候选供应商', '拿到候选供应商的联系方式', '比价表写好并交付'],
    tools: ['浏览器（采购-1）', 'browser_open', 'browser_snapshot', 'browser_click', 'sheet_write', 'ask_human'],
    rules: ['对外发询价要主管批准', '单次花费上限 ¥5'],
    deliverables: ['比价表-日期.xlsx'],
    memory: ['顺发支持 100 起订的定制款（来自 R-1102-4）', '乐享周五不发货（来自 R-1030-1）'],
  },
  {
    id: 'T-9', name: '竞品价格监控', category: '运营', owner: '王芳', enabled: true, schedule: '每 4 小时', next: '今天 14:00',
    runs: '今天 2 次 · 等人 1', model: 'HeyAgent 规划模型',
    goal: '拼多多、淘宝上 12 个竞品链接的价格和券后价，有变化就通知运营群。', steps: ['逐个打开竞品链接', '读价格和券', '和上次对比', '有变化发飞书'],
    checkpoints: ['12 个链接都读到价格'], tools: ['浏览器（运营-2）', '飞书通知'], rules: [], deliverables: ['价格变化表'], memory: [],
  },
  {
    id: 'T-7', name: '供应商对账', category: '财务', owner: '李娜', enabled: true, schedule: '每月 1 号', next: '12 月 1 日',
    runs: '本月 1 次 · 等人 1', model: 'HeyAgent 规划模型', goal: '拉 ERP 账单和供应商报价单核对，生成付款申请。',
    steps: ['从 ERP 导出账单', '读供应商报价单', '逐行核对', '生成付款申请（要审批）'], checkpoints: ['账单逐行核对完'], tools: ['桌面（财务-Win11）', 'ERP API'], rules: ['付款要主管批准'], deliverables: ['对账差异表', '付款申请'], memory: [],
  },
  {
    id: 'T-5', name: '新品上架检查', category: '运营', owner: '王芳', enabled: true, schedule: '派活触发', next: '—',
    runs: '本周 6 次 · 办成 5', model: 'HeyAgent 规划模型', goal: '新品上架后检查主图、详情、尺码表、运费模板。', steps: ['打开商品页', '逐项检查', '截图存证'], checkpoints: ['8 项都检查完'], tools: ['浏览器'], rules: [], deliverables: ['检查报告'], memory: [],
  },
  {
    id: 'T-3', name: '售后工单分类', category: '客服', owner: '赵磊', enabled: false, schedule: '已停用', next: '—',
    runs: '上周 14 次', model: 'HeyAgent 规划模型', goal: '把新工单按退货 / 换货 / 咨询分类并分派。', steps: ['读新工单', '分类', '分派'], checkpoints: [], tools: ['工单系统 API'], rules: [], deliverables: [], memory: [],
  },
]

export const BROWSERS = [
  { id: 'b1', name: '采购-1', state: 'human', stateLabel: '等人处理 · 保留到 10:45', run: 'R-1106-3', proxy: '直连', accounts: [['1688', 'buyer01', '要登录'], ['淘宝', 'buyer01', '已登录']] },
  { id: 'b2', name: '运营-2', state: 'human', stateLabel: '等人处理 · 验证码', run: 'R-1106-1', proxy: '上海住宅代理', accounts: [['拼多多', 'ops02', '已登录'], ['淘宝', 'ops02', '已登录']] },
  { id: 'b3', name: '运营-3', state: 'running', stateLabel: '运行中 R-1106-4', run: 'R-1106-4', proxy: '直连', accounts: [['抖店', 'ops03', '已登录']] },
  { id: 'b4', name: '客服-1', state: 'idle', stateLabel: '空闲', proxy: '直连', accounts: [['千牛', 'kefu01', '已登录']] },
]

export const DESKTOPS = [
  { id: 'd1', name: '财务-Win11', group: '桌面', kind: '虚拟机', state: 'on', stateLabel: '开着', detail: '4 核 · 8 GB · SSD /mnt/nvme', run: 'R-1105-7' },
  { id: 'd2', name: '前台-Win10（手动登记）', group: '桌面', kind: '手动', state: 'idle', stateLabel: '空着', detail: '192.168.31.42 · 连得上' },
  { id: 'd3', name: '设计-Win11', group: '桌面', kind: '虚拟机', state: 'off', stateLabel: '关着', detail: '4 核 · 16 GB · HDD /mnt/toshiba' },
  { id: 'd4', name: 'Win11 办公模板', group: '模板', kind: '模板', state: 'ready', stateLabel: '做好了', detail: '装了 WPS、企业微信、ERP 客户端' },
  { id: 'd5', name: 'Win11 设计模板', group: '模板', kind: '模板', state: 'wait', stateLabel: '等装软件', detail: '等主管装 PS 后点「做好了」' },
]
