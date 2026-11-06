window.__ModuleLoader__.load({ id: "heyagent-ui", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.jsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");

// src/pages.jsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/data.js
var INBOX = [
  {
    id: "A-1043",
    kind: "approval",
    kindLabel: "\u5BA1\u6279",
    title: "\u5BF9\u5916\u53D1\u8BE2\u4EF7\uFF1A\u4E49\u4E4C\u4E50\u4EAB\u676F\u4E1A",
    run: "R-1106-3",
    task: "\u6BCF\u65E5\u6BD4\u4EF7",
    who: "\u5F20\u4F1F\uFF08\u4E3B\u7BA1\uFF09",
    age: "3 \u5206\u949F",
    state: "pending",
    summary: "\u89C4\u5219\u300C\u5BF9\u5916\u53D1\u8BE2\u4EF7\u8981\u4E3B\u7BA1\u6279\u51C6\u300D\u62E6\u4E0B\u4E86 agent \u7684\u300C\u53D1\u9001\u8BE2\u4EF7\u300D\u3002\u6279\u51C6\u540E\u8FD0\u884C\u4ECE\u8FD9\u4E00\u6B65\u7EE7\u7EED\u3002",
    fields: [
      ["\u89C4\u5219", "\u5BF9\u5916\u53D1\u8BE2\u4EF7\u8981\u4E3B\u7BA1\u6279\u51C6\uFF08R-07\uFF09"],
      ["\u8FD0\u884C", "R-1106-3 \xB7 \u6BCF\u65E5\u6BD4\u4EF7 \xB7 \u7B49\u4EBA\u5904\u7406"],
      ["\u4F9B\u5E94\u5546", "\u4E49\u4E4C\u4E50\u4EAB\u676F\u4E1A\uFF081688 \u8BDA\u4FE1\u901A 6 \u5E74\uFF09"],
      ["\u8BE2\u4EF7\u5185\u5BB9", "\u4E0D\u9508\u94A2\u4FDD\u6E29\u676F 500ml \xD7 500 \u4E2A\uFF0C\u76EE\u6807\u5355\u4EF7 \u2264 \xA59.50\uFF0C\u542B logo \u6FC0\u5149\u96D5\u523B\uFF0C11 \u6708 20 \u65E5\u524D\u5230\u4E49\u4E4C\u4ED3"],
      ["agent \u7684\u7406\u7531", "\u7EFC\u5408\u4EF7\u683C\u3001\u8D77\u8BA2\u91CF\u3001\u56DE\u5934\u7387\u6392\u7B2C\u4E00\uFF1B48 \u5C0F\u65F6\u53D1\u8D27"]
    ],
    actions: ["\u6279\u51C6", "\u9A73\u56DE", "\u6539\u4E86\u518D\u6279"]
  },
  {
    id: "L-88",
    kind: "login",
    kindLabel: "\u767B\u5F55",
    title: "1688 \u8981\u767B\u5F55\uFF1Abuyer01",
    run: "R-1106-3",
    task: "\u6BCF\u65E5\u6BD4\u4EF7",
    who: "\u91C7\u8D2D\u7EC4",
    age: "1 \u5206\u949F",
    state: "pending",
    browser: true,
    summary: "\u770B\u4F9B\u5E94\u5546\u8054\u7CFB\u65B9\u5F0F\u8981\u5148\u767B\u5F55\u3002\u63A5\u624B\u6D4F\u89C8\u5668\uFF0C\u5728\u8FDC\u7A0B\u753B\u9762\u91CC\u767B\u5F55\uFF0C\u7136\u540E\u70B9\u300C\u5DF2\u5904\u7406\u597D\u4E86\u300D\u3002",
    fields: [
      ["\u6D4F\u89C8\u5668", "\u91C7\u8D2D-1\uFF08\u4FDD\u7559\u5230 10:45\uFF09"],
      ["\u8D26\u53F7", "buyer01 \xB7 \u5BC6\u7801\u5728\u4FDD\u9669\u7BB1"],
      ["\u9875\u9762", "https://login.1688.com/member/signin.htm"]
    ],
    actions: ["\u63A5\u624B\u6D4F\u89C8\u5668", "\u5DF2\u5904\u7406\u597D\u4E86", "\u4E0D\u767B\u5F55\uFF0C\u8DF3\u8FC7"]
  },
  {
    id: "C-212",
    kind: "captcha",
    kindLabel: "\u9A8C\u8BC1\u7801",
    title: "\u62FC\u591A\u591A\u6ED1\u5757\u9A8C\u8BC1",
    run: "R-1106-1",
    task: "\u7ADE\u54C1\u4EF7\u683C\u76D1\u63A7",
    who: "\u8FD0\u8425\u7EC4",
    age: "9 \u5206\u949F",
    state: "pending",
    browser: true,
    summary: "agent \u81EA\u5DF1\u8BD5\u4E86 2 \u6B21\u6CA1\u8FC7\u3002\u8BF7\u5728\u8FDC\u7A0B\u753B\u9762\u91CC\u62D6\u4E00\u4E0B\u6ED1\u5757\u3002",
    fields: [["\u6D4F\u89C8\u5668", "\u8FD0\u8425-2"], ["\u9875\u9762", "mobile.yangkeduo.com"], ["\u5DF2\u81EA\u52A8\u91CD\u8BD5", "2 \u6B21"]],
    actions: ["\u63A5\u624B\u6D4F\u89C8\u5668", "\u5DF2\u5904\u7406\u597D\u4E86"]
  },
  {
    id: "Q-17",
    kind: "question",
    kindLabel: "\u56DE\u7B54",
    title: "\u62A5\u4EF7\u8981\u4E0D\u8981\u542B\u7A0E\uFF1F",
    run: "R-1105-7",
    task: "\u4F9B\u5E94\u5546\u5BF9\u8D26",
    who: "\u674E\u5A1C",
    age: "22 \u5206\u949F",
    state: "pending",
    summary: "agent \u4E0D\u786E\u5B9A\u5BF9\u8D26\u5355\u91CC\u7684\u5355\u4EF7\u662F\u5426\u8981\u6309\u542B\u7A0E\u4EF7\u6838\u5BF9\u3002",
    fields: [["\u95EE\u9898", "\u4F9B\u5E94\u5546 \u6C38\u5EB7\u534E\u7F8E \u7684\u62A5\u4EF7\u5355\u5199\u7684\u662F\u4E0D\u542B\u7A0E\u4EF7\uFF0C\u5BF9\u8D26\u5355\u6309\u542B\u7A0E\u4EF7\u6838\uFF0C\u8FD8\u662F\u6309\u4E0D\u542B\u7A0E\u4EF7\u6838\uFF1F"], ["\u9009\u9879", "\u542B\u7A0E 13% / \u4E0D\u542B\u7A0E / \u90FD\u5217\u51FA\u6765"]],
    actions: ["\u56DE\u7B54"]
  },
  {
    id: "V-9",
    kind: "verify",
    kindLabel: "\u9A8C\u6536\u5F85\u5B9A",
    title: "\u65B0\u54C1\u4E0A\u67B6\u68C0\u67E5\uFF1A3 \u9879\u62FF\u4E0D\u51C6",
    run: "R-1104-2",
    task: "\u65B0\u54C1\u4E0A\u67B6\u68C0\u67E5",
    who: "\u738B\u82B3",
    age: "2 \u5C0F\u65F6",
    state: "pending",
    summary: "\u4E09\u65B9\u9A8C\u6536\u5BF9 3 \u4E2A\u68C0\u67E5\u9879\u6CA1\u628A\u63E1\uFF0C\u8BF7\u4EBA\u5224\u5B9A\u529E\u6210\u8FD8\u662F\u6CA1\u529E\u6210\u3002",
    fields: [["\u62FF\u4E0D\u51C6\u7684\u9879", "\u4E3B\u56FE\u662F\u5426\u6709\u6C34\u5370 \xB7 \u5C3A\u7801\u8868\u662F\u5426\u5B8C\u6574 \xB7 \u8FD0\u8D39\u6A21\u677F"], ["\u622A\u56FE", "6 \u5F20\uFF08\u5728\u8FD0\u884C\u7A7A\u95F4\uFF09"]],
    actions: ["\u7B97\u529E\u6210", "\u7B97\u6CA1\u529E\u6210", "\u6253\u5F00\u8FD0\u884C"]
  },
  {
    id: "A-1039",
    kind: "approval",
    kindLabel: "\u5BA1\u6279",
    title: "\u4ED8\u6B3E\u7533\u8BF7 \xA53,860",
    run: "R-1105-2",
    task: "\u4F9B\u5E94\u5546\u5BF9\u8D26",
    who: "\u5F20\u4F1F\uFF08\u4E3B\u7BA1\uFF09",
    age: "\u6628\u5929",
    state: "done",
    result: "\u5DF2\u6279\u51C6 \xB7 \u5F20\u4F1F",
    summary: "\u5BF9\u8D26\u5B8C\u6210\u540E\u751F\u6210\u7684\u4ED8\u6B3E\u7533\u8BF7\u3002",
    fields: [["\u91D1\u989D", "\xA53,860.00"], ["\u6536\u6B3E\u65B9", "\u6D59\u6C5F\u987A\u53D1\u65E5\u7528\u54C1"]],
    actions: []
  }
];
var TASKS = [
  {
    id: "T-12",
    name: "\u6BCF\u65E5\u6BD4\u4EF7",
    category: "\u91C7\u8D2D",
    owner: "\u5F20\u4F1F",
    enabled: true,
    schedule: "\u5DE5\u4F5C\u65E5 09:00",
    next: "\u660E\u5929 09:00",
    runs: "\u4ECA\u5929 3 \u6B21 \xB7 \u529E\u6210 2 \xB7 \u7B49\u4EBA 1",
    model: "HeyAgent \u89C4\u5212\u6A21\u578B",
    goal: "\u5728 1688 \u627E\u6307\u5B9A\u54C1\u7C7B\u7684\u524D 20 \u4E2A\u5546\u54C1\uFF0C\u6BD4\u4EF7\u683C\u3001\u8D77\u8BA2\u91CF\u3001\u56DE\u5934\u7387\uFF0C\u6311 3 \u5BB6\u53D1\u8BE2\u4EF7\uFF0C\u4EA4\u4E00\u5F20\u6BD4\u4EF7\u8868\u3002",
    steps: ["\u6253\u5F00 1688 \u641C\u7D22\u4EFB\u52A1\u53C2\u6570\u91CC\u7684\u5173\u952E\u8BCD", "\u8BFB\u524D 20 \u4E2A\u5546\u54C1\u7684\u4EF7\u683C\u3001\u8D77\u8BA2\u91CF\u3001\u56DE\u5934\u7387", "\u6392\u9664\u56DE\u5934\u7387 < 20% \u7684", "\u7ED9\u7EFC\u5408\u524D 3 \u540D\u53D1\u8BE2\u4EF7\uFF08\u8981\u5BA1\u6279\uFF09", "\u5199\u6BD4\u4EF7\u8868\u4EA4\u4ED8"],
    checkpoints: ["\u627E\u5230\u81F3\u5C11 3 \u5BB6\u5019\u9009\u4F9B\u5E94\u5546", "\u62FF\u5230\u5019\u9009\u4F9B\u5E94\u5546\u7684\u8054\u7CFB\u65B9\u5F0F", "\u6BD4\u4EF7\u8868\u5199\u597D\u5E76\u4EA4\u4ED8"],
    tools: ["\u6D4F\u89C8\u5668\uFF08\u91C7\u8D2D-1\uFF09", "browser_open", "browser_snapshot", "browser_click", "sheet_write", "ask_human"],
    rules: ["\u5BF9\u5916\u53D1\u8BE2\u4EF7\u8981\u4E3B\u7BA1\u6279\u51C6", "\u5355\u6B21\u82B1\u8D39\u4E0A\u9650 \xA55"],
    deliverables: ["\u6BD4\u4EF7\u8868-\u65E5\u671F.xlsx"],
    memory: ["\u987A\u53D1\u652F\u6301 100 \u8D77\u8BA2\u7684\u5B9A\u5236\u6B3E\uFF08\u6765\u81EA R-1102-4\uFF09", "\u4E50\u4EAB\u5468\u4E94\u4E0D\u53D1\u8D27\uFF08\u6765\u81EA R-1030-1\uFF09"]
  },
  {
    id: "T-9",
    name: "\u7ADE\u54C1\u4EF7\u683C\u76D1\u63A7",
    category: "\u8FD0\u8425",
    owner: "\u738B\u82B3",
    enabled: true,
    schedule: "\u6BCF 4 \u5C0F\u65F6",
    next: "\u4ECA\u5929 14:00",
    runs: "\u4ECA\u5929 2 \u6B21 \xB7 \u7B49\u4EBA 1",
    model: "HeyAgent \u89C4\u5212\u6A21\u578B",
    goal: "\u62FC\u591A\u591A\u3001\u6DD8\u5B9D\u4E0A 12 \u4E2A\u7ADE\u54C1\u94FE\u63A5\u7684\u4EF7\u683C\u548C\u5238\u540E\u4EF7\uFF0C\u6709\u53D8\u5316\u5C31\u901A\u77E5\u8FD0\u8425\u7FA4\u3002",
    steps: ["\u9010\u4E2A\u6253\u5F00\u7ADE\u54C1\u94FE\u63A5", "\u8BFB\u4EF7\u683C\u548C\u5238", "\u548C\u4E0A\u6B21\u5BF9\u6BD4", "\u6709\u53D8\u5316\u53D1\u98DE\u4E66"],
    checkpoints: ["12 \u4E2A\u94FE\u63A5\u90FD\u8BFB\u5230\u4EF7\u683C"],
    tools: ["\u6D4F\u89C8\u5668\uFF08\u8FD0\u8425-2\uFF09", "\u98DE\u4E66\u901A\u77E5"],
    rules: [],
    deliverables: ["\u4EF7\u683C\u53D8\u5316\u8868"],
    memory: []
  },
  {
    id: "T-7",
    name: "\u4F9B\u5E94\u5546\u5BF9\u8D26",
    category: "\u8D22\u52A1",
    owner: "\u674E\u5A1C",
    enabled: true,
    schedule: "\u6BCF\u6708 1 \u53F7",
    next: "12 \u6708 1 \u65E5",
    runs: "\u672C\u6708 1 \u6B21 \xB7 \u7B49\u4EBA 1",
    model: "HeyAgent \u89C4\u5212\u6A21\u578B",
    goal: "\u62C9 ERP \u8D26\u5355\u548C\u4F9B\u5E94\u5546\u62A5\u4EF7\u5355\u6838\u5BF9\uFF0C\u751F\u6210\u4ED8\u6B3E\u7533\u8BF7\u3002",
    steps: ["\u4ECE ERP \u5BFC\u51FA\u8D26\u5355", "\u8BFB\u4F9B\u5E94\u5546\u62A5\u4EF7\u5355", "\u9010\u884C\u6838\u5BF9", "\u751F\u6210\u4ED8\u6B3E\u7533\u8BF7\uFF08\u8981\u5BA1\u6279\uFF09"],
    checkpoints: ["\u8D26\u5355\u9010\u884C\u6838\u5BF9\u5B8C"],
    tools: ["\u684C\u9762\uFF08\u8D22\u52A1-Win11\uFF09", "ERP API"],
    rules: ["\u4ED8\u6B3E\u8981\u4E3B\u7BA1\u6279\u51C6"],
    deliverables: ["\u5BF9\u8D26\u5DEE\u5F02\u8868", "\u4ED8\u6B3E\u7533\u8BF7"],
    memory: []
  },
  {
    id: "T-5",
    name: "\u65B0\u54C1\u4E0A\u67B6\u68C0\u67E5",
    category: "\u8FD0\u8425",
    owner: "\u738B\u82B3",
    enabled: true,
    schedule: "\u6D3E\u6D3B\u89E6\u53D1",
    next: "\u2014",
    runs: "\u672C\u5468 6 \u6B21 \xB7 \u529E\u6210 5",
    model: "HeyAgent \u89C4\u5212\u6A21\u578B",
    goal: "\u65B0\u54C1\u4E0A\u67B6\u540E\u68C0\u67E5\u4E3B\u56FE\u3001\u8BE6\u60C5\u3001\u5C3A\u7801\u8868\u3001\u8FD0\u8D39\u6A21\u677F\u3002",
    steps: ["\u6253\u5F00\u5546\u54C1\u9875", "\u9010\u9879\u68C0\u67E5", "\u622A\u56FE\u5B58\u8BC1"],
    checkpoints: ["8 \u9879\u90FD\u68C0\u67E5\u5B8C"],
    tools: ["\u6D4F\u89C8\u5668"],
    rules: [],
    deliverables: ["\u68C0\u67E5\u62A5\u544A"],
    memory: []
  },
  {
    id: "T-3",
    name: "\u552E\u540E\u5DE5\u5355\u5206\u7C7B",
    category: "\u5BA2\u670D",
    owner: "\u8D75\u78CA",
    enabled: false,
    schedule: "\u5DF2\u505C\u7528",
    next: "\u2014",
    runs: "\u4E0A\u5468 14 \u6B21",
    model: "HeyAgent \u89C4\u5212\u6A21\u578B",
    goal: "\u628A\u65B0\u5DE5\u5355\u6309\u9000\u8D27 / \u6362\u8D27 / \u54A8\u8BE2\u5206\u7C7B\u5E76\u5206\u6D3E\u3002",
    steps: ["\u8BFB\u65B0\u5DE5\u5355", "\u5206\u7C7B", "\u5206\u6D3E"],
    checkpoints: [],
    tools: ["\u5DE5\u5355\u7CFB\u7EDF API"],
    rules: [],
    deliverables: [],
    memory: []
  }
];
var BROWSERS = [
  { id: "b1", name: "\u91C7\u8D2D-1", state: "human", stateLabel: "\u7B49\u4EBA\u5904\u7406 \xB7 \u4FDD\u7559\u5230 10:45", run: "R-1106-3", proxy: "\u76F4\u8FDE", accounts: [["1688", "buyer01", "\u8981\u767B\u5F55"], ["\u6DD8\u5B9D", "buyer01", "\u5DF2\u767B\u5F55"]] },
  { id: "b2", name: "\u8FD0\u8425-2", state: "human", stateLabel: "\u7B49\u4EBA\u5904\u7406 \xB7 \u9A8C\u8BC1\u7801", run: "R-1106-1", proxy: "\u4E0A\u6D77\u4F4F\u5B85\u4EE3\u7406", accounts: [["\u62FC\u591A\u591A", "ops02", "\u5DF2\u767B\u5F55"], ["\u6DD8\u5B9D", "ops02", "\u5DF2\u767B\u5F55"]] },
  { id: "b3", name: "\u8FD0\u8425-3", state: "running", stateLabel: "\u8FD0\u884C\u4E2D R-1106-4", run: "R-1106-4", proxy: "\u76F4\u8FDE", accounts: [["\u6296\u5E97", "ops03", "\u5DF2\u767B\u5F55"]] },
  { id: "b4", name: "\u5BA2\u670D-1", state: "idle", stateLabel: "\u7A7A\u95F2", proxy: "\u76F4\u8FDE", accounts: [["\u5343\u725B", "kefu01", "\u5DF2\u767B\u5F55"]] }
];
var DESKTOPS = [
  { id: "d1", name: "\u8D22\u52A1-Win11", group: "\u684C\u9762", kind: "\u865A\u62DF\u673A", state: "on", stateLabel: "\u5F00\u7740", detail: "4 \u6838 \xB7 8 GB \xB7 SSD /mnt/nvme", run: "R-1105-7" },
  { id: "d2", name: "\u524D\u53F0-Win10\uFF08\u624B\u52A8\u767B\u8BB0\uFF09", group: "\u684C\u9762", kind: "\u624B\u52A8", state: "idle", stateLabel: "\u7A7A\u7740", detail: "192.168.31.42 \xB7 \u8FDE\u5F97\u4E0A" },
  { id: "d3", name: "\u8BBE\u8BA1-Win11", group: "\u684C\u9762", kind: "\u865A\u62DF\u673A", state: "off", stateLabel: "\u5173\u7740", detail: "4 \u6838 \xB7 16 GB \xB7 HDD /mnt/toshiba" },
  { id: "d4", name: "Win11 \u529E\u516C\u6A21\u677F", group: "\u6A21\u677F", kind: "\u6A21\u677F", state: "ready", stateLabel: "\u505A\u597D\u4E86", detail: "\u88C5\u4E86 WPS\u3001\u4F01\u4E1A\u5FAE\u4FE1\u3001ERP \u5BA2\u6237\u7AEF" },
  { id: "d5", name: "Win11 \u8BBE\u8BA1\u6A21\u677F", group: "\u6A21\u677F", kind: "\u6A21\u677F", state: "wait", stateLabel: "\u7B49\u88C5\u8F6F\u4EF6", detail: "\u7B49\u4E3B\u7BA1\u88C5 PS \u540E\u70B9\u300C\u505A\u597D\u4E86\u300D" }
];

// src/pages.jsx
var import_jsx_runtime = require("react/jsx-runtime");
var KIND_ICON = {
  approval: import_dsh_client_ui_primitives.IconShieldOutlineRegular,
  login: import_dsh_client_ui_primitives.IconUserOutlineRegular,
  captcha: import_dsh_client_ui_primitives.IconWarningOutlineRegular,
  question: import_dsh_client_ui_primitives.IconQuestionOutlineRegular,
  verify: import_dsh_client_ui_primitives.IconChecklistOutlineRegular
};
function PanelFrame({ title, help, actions, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h1", { children: [
        title,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-help", title: help, children: "?" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-actions", children: [
        actions,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", className: "ha-pillbtn", children: "\u52A9\u624B" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-body", children })
  ] });
}
function Chips({ items, value, onChange }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-chips", children: items.map(([v, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "ha-chip" + (v === value ? " ha-chip-on" : ""), onClick: () => onChange(v), children: label }, v)) });
}
function Search({ placeholder }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "ha-search", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: 14 }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { placeholder })
  ] });
}
function Fields({ rows }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dl", { className: "ha-dl", children: rows.map(([k, v]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: k }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: v })
  ] }, k)) });
}
function Section({ title, icon: Icon, children, extra }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "ha-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-card-head", children: [
      Icon ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { size: 16 }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: title }),
      extra
    ] }),
    children
  ] });
}
function InboxPage({ onOpenRun, onOpenRemote }) {
  const [tab, setTab] = (0, import_react.useState)("pending");
  const [sel, setSel] = (0, import_react.useState)("A-1043");
  const rows = INBOX.filter((i) => tab === "pending" ? i.state === "pending" : tab === "done" ? i.state === "done" : false);
  const item = INBOX.find((i) => i.id === sel) ?? rows[0];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PanelFrame, { title: "\u8981\u4EBA\u529E", help: "\u6321\u4F4F\u8FD0\u884C\u3001\u8981\u4EBA\u6765\u529E\u7684\u4E8B\uFF1A\u5BA1\u6279\u3001\u767B\u5F55\u3001\u9A8C\u8BC1\u7801\u3001\u56DE\u7B54\u3001\u9A8C\u6536\u5F85\u5B9A\u3002", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-split", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-list", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Chips, { value: tab, onChange: setTab, items: [["pending", "\u5F85\u5904\u7406 5"], ["done", "\u5DF2\u5904\u7406"], ["notice", "\u901A\u77E5 2"]] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Search, { placeholder: "\u641C\u7D22\u8FD0\u884C\u53F7\u3001\u4EFB\u52A1\u3001\u5185\u5BB9" }),
      tab === "notice" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-rows", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-glyph", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "done" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-row-title", children: "R-1106-2 \u6BCF\u65E5\u6BD4\u4EF7 \u5DF2\u529E\u6210" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-meta", children: "AI \u590D\u6838\u901A\u8FC7 \xB7 8:52" })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-glyph", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "error" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-row-title", children: "R-1105-9 \u7ADE\u54C1\u4EF7\u683C\u76D1\u63A7 \u6CA1\u529E\u6210" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-meta", children: "\u62FC\u591A\u591A\u6539\u7248\uFF0C3 \u4E2A\u94FE\u63A5\u8BFB\u4E0D\u5230 \xB7 \u6628\u5929" })
          ] })
        ] })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-rows", children: rows.map((i) => {
        const Icon = KIND_ICON[i.kind];
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "ha-row" + (item?.id === i.id ? " ha-row-on" : ""), onClick: () => setSel(i.id), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-glyph", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { size: 16 }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row-main", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-row-title", children: i.title }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-meta", children: [
              i.kindLabel,
              " \xB7 ",
              i.run,
              " ",
              i.task,
              " \xB7 ",
              i.age
            ] })
          ] }),
          i.state === "pending" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "warning", children: i.kindLabel }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "success", children: "\u5DF2\u5904\u7406" })
        ] }, i.id);
      }) })
    ] }),
    item && tab !== "notice" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-detail-title", children: item.title }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-meta", children: [
            item.id,
            " \xB7 \u5206\u7ED9 ",
            item.who,
            " \xB7 ",
            item.age,
            "\u524D"
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", onClick: onOpenRun, icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPlayOutlineRegular, { size: 14 }), children: [
          "\u6253\u5F00\u8FD0\u884C ",
          item.run
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "ha-lead", children: item.summary }),
      item.browser ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-shot-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FakeBrowser, { compact: true, login: item.kind === "login", captcha: item.kind === "captcha" }) }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fields, { rows: item.fields }),
      item.kind === "question" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { className: "ha-textarea", placeholder: "\u5199\u7ED9 agent \u7684\u56DE\u7B54\u2026", defaultValue: "\u6309\u542B\u7A0E 13% \u6838\uFF0C\u62A5\u4EF7\u5355\u53E6\u5217\u4E0D\u542B\u7A0E\u4EF7\u3002" }) : null,
      item.result ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "success", children: item.result }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-btnrow", children: item.actions.map((a, idx) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: idx === 0 ? "primary" : "outline", onClick: a === "\u63A5\u624B\u6D4F\u89C8\u5668" ? onOpenRemote : a === "\u6253\u5F00\u8FD0\u884C" ? onOpenRun : void 0, children: a }, a)) })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-detail ha-empty", children: "\u9009\u4E00\u4EF6\u4E8B\u770B\u8BE6\u60C5" })
  ] }) });
}
function TasksPage({ onNewRun }) {
  const [sel, setSel] = (0, import_react.useState)("T-12");
  const [filter, setFilter] = (0, import_react.useState)("all");
  const [tab, setTab] = (0, import_react.useState)("structure");
  const rows = TASKS.filter((t2) => filter === "all" || (filter === "mine" ? t2.owner === "\u5F20\u4F1F" : !t2.enabled));
  const t = TASKS.find((x) => x.id === sel) ?? rows[0];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    PanelFrame,
    {
      title: "\u4EFB\u52A1",
      help: "\u4EFB\u52A1 = \u4E00\u4EFD\u914D\u7F6E\uFF1A\u76EE\u6807\u3001\u6B65\u9AA4\u3001\u68C0\u67E5\u70B9\u3001\u5DE5\u5177\u3001\u89C4\u5219\u3001\u4EA4\u4ED8\u7269\u3001\u4EC0\u4E48\u65F6\u5019\u8DD1\u3002\u6BCF\u6B21\u6267\u884C\u662F\u4E00\u6B21\u8FD0\u884C\u3002",
      actions: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", className: "ha-pillbtn", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }), children: "\u65B0\u5EFA\u4EFB\u52A1" }),
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-split", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-list", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Chips, { value: filter, onChange: setFilter, items: [["all", "\u5168\u90E8"], ["mine", "\u6211\u8D1F\u8D23\u7684"], ["off", "\u5DF2\u505C\u7528"]] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Search, { placeholder: "\u641C\u7D22\u4EFB\u52A1" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-rows", children: rows.map((x) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "ha-row" + (t?.id === x.id ? " ha-row-on" : ""), onClick: () => setSel(x.id), children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-glyph", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChecklistOutlineRegular, { size: 16 }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row-main", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-row-title", children: x.name }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-meta", children: [
                x.category,
                " \xB7 ",
                x.owner,
                " \xB7 ",
                x.schedule
              ] })
            ] }),
            x.enabled ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "success", children: "\u542F\u7528" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "neutral", children: "\u505C\u7528" })
          ] }, x.id)) })
        ] }),
        t ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail-title", children: [
                t.name,
                " ",
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-meta", children: t.id })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-meta", children: [
                "\u8D1F\u8D23\u4EBA ",
                t.owner,
                " \xB7 ",
                t.schedule,
                " \xB7 \u4E0B\u6B21 ",
                t.next,
                " \xB7 ",
                t.runs
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-btnrow ha-tight", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconEditOutlineRegular, { size: 14 }), children: "\u7F16\u8F91" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", onClick: onNewRun, icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPlayOutlineRegular, { size: 14 }), children: "\u65B0\u8FD0\u884C" })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.SegmentedTabs, { size: "sm", label: "\u4EFB\u52A1\u8BE6\u60C5", value: tab, onChange: setTab, className: "ha-tabs", items: [
            { value: "structure", label: "\u7ED3\u6784\u56FE", id: "ha-t-s", panelId: "ha-p-s" },
            { value: "runs", label: "\u8FD0\u884C", id: "ha-t-r", panelId: "ha-p-r" },
            { value: "when", label: "\u4EC0\u4E48\u65F6\u5019\u8DD1", id: "ha-t-w", panelId: "ha-p-w" },
            { value: "memory", label: "\u4EFB\u52A1\u8BB0\u5FC6", id: "ha-t-m", panelId: "ha-p-m" }
          ] }),
          tab === "structure" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TaskStructure, { t }) : null,
          tab === "runs" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-rows", children: [["R-1106-3", "warning", "\u7B49\u4EBA\u5904\u7406 \xB7 \u5F85\u6279\u51C6", "3 \u5206\u949F\u524D"], ["R-1106-2", "done", "\u529E\u6210 \xB7 AI \u590D\u6838\u901A\u8FC7", "8:52"], ["R-1105-1", "done", "\u529E\u6210", "\u6628\u5929"], ["R-1104-1", "error", "\u6CA1\u529E\u6210 \xB7 1688 \u6539\u7248", "\u5468\u4E8C"]].map(([id, st, label, when]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-glyph", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: st }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row-main", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row-title", children: [
                id,
                " \u6BCF\u65E5\u6BD4\u4EF7"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-meta", children: label })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-meta", children: when })
          ] }, id)) }) : null,
          tab === "when" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fields, { rows: [["\u5B9A\u65F6", t.schedule], ["\u4E0B\u6B21", t.next], ["\u6D3E\u6D3B", "\u53EF\u4EE5\u88AB\u300C\u65B0\u54C1\u4E0A\u67B6\u68C0\u67E5\u300D\u6D3E\u6D3B"], ["\u5916\u90E8\u4E8B\u4EF6", "POST /api/events \xB7 price.alert"]] }) : null,
          tab === "memory" ? t.memory.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "ha-ul", children: t.memory.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: m }, m)) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-empty", children: "\u8FD8\u6CA1\u6709\u4EFB\u52A1\u8BB0\u5FC6" }) : null
        ] }) : null
      ] })
    }
  );
}
function TaskStructure({ t }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-structure", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: "\u76EE\u6807", icon: import_dsh_client_ui_primitives.IconGoalOutlineRegular, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "ha-p", children: t.goal }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-loop", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-loop-label", children: [
        "agent \u5FAA\u73AF \xB7 ",
        t.model
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-grid2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: `\u6B65\u9AA4 ${t.steps.length}`, icon: import_dsh_client_ui_primitives.IconChecklistOutlineRegular, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", { className: "ha-ol", children: t.steps.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: s }, s)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: `\u68C0\u67E5\u70B9 ${t.checkpoints.length}`, icon: import_dsh_client_ui_primitives.IconCheckCircleOutlineRegular, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", { className: "ha-ol", children: t.checkpoints.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: s }, s)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: "\u5DE5\u5177", icon: import_dsh_client_ui_primitives.IconCodeOutlineRegular, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-tags", children: t.tools.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "outline", children: s }, s)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: "\u89C4\u5219", icon: import_dsh_client_ui_primitives.IconShieldOutlineRegular, children: t.rules.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "ha-ul", children: t.rules.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: s }, s)) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-meta", children: "\u6CA1\u6709" }) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: "\u4EA4\u4ED8\u7269", icon: import_dsh_client_ui_primitives.IconDeliverDocRegular, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-tags", children: t.deliverables.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "info", children: s }, s)) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: "\u6280\u80FD / \u8BB0\u5FC6", icon: import_dsh_client_ui_primitives.IconSkillOutlineRegular, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-tags", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "neutral", children: "\u91C7\u8D2D\u6BD4\u4EF7 SKILL.md" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "neutral", children: "1688 \u64CD\u4F5C\u8981\u70B9" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_dsh_client_ui_primitives.Tag, { tone: "neutral", children: [
        "\u4EFB\u52A1\u8BB0\u5FC6 ",
        t.memory.length
      ] })
    ] }) })
  ] });
}
function BrowsersPage({ onOpenRemote }) {
  const [sel, setSel] = (0, import_react.useState)("b1");
  const b = BROWSERS.find((x) => x.id === sel);
  const tone = (s) => s === "human" ? "warning" : s === "running" ? "info" : "outline";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    PanelFrame,
    {
      title: "\u6D4F\u89C8\u5668",
      help: "\u670D\u52A1\u5668\u4E0A\u7684 Chrome \u914D\u7F6E\uFF1A\u4EE3\u7406\u3001\u5E73\u53F0\u8D26\u53F7\u3001\u4FDD\u9669\u7BB1\uFF1B\u8FD0\u884C\u5360\u7528\u65F6\u53EF\u4EE5\u770B\u753B\u9762\u3001\u63A5\u624B\u3002",
      actions: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", className: "ha-pillbtn", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }), children: "\u65B0\u5EFA Chrome" }),
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-split", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-list", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Search, { placeholder: "\u641C\u7D22 Chrome \u914D\u7F6E" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-rows", children: BROWSERS.map((x) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "ha-row" + (x.id === sel ? " ha-row-on" : ""), onClick: () => setSel(x.id), children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-glyph", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconGlobeOutlineRegular, { size: 16 }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row-main", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-row-title", children: x.name }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-meta", children: [
                x.proxy,
                " \xB7 ",
                x.accounts.length,
                " \u4E2A\u8D26\u53F7"
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: tone(x.state), children: x.stateLabel.split(" \xB7 ")[0] })
          ] }, x.id)) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-detail-title", children: b.name }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-meta", children: b.stateLabel })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-btnrow ha-tight", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", children: "\u6253\u5F00 Chrome" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", onClick: onOpenRemote, icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconFullscreenOutlineRegular, { size: 14 }), children: "\u770B\u753B\u9762" })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-shot-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FakeBrowser, { compact: true, login: b.id === "b1", captcha: b.id === "b2" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: "\u5E73\u53F0\u548C\u8D26\u53F7", icon: import_dsh_client_ui_primitives.IconUserOutlineRegular, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-rows", children: b.accounts.map(([p, a, s]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row ha-row-flat", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-row-main", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row-title", children: [
              p,
              " \xB7 ",
              a
            ] }) }),
            s === "\u5DF2\u767B\u5F55" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "success", children: "\u5DF2\u767B\u5F55" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "warning", children: s }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", children: "\u7ACB\u523B\u767B\u5F55" })
            ] })
          ] }, p)) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fields, { rows: [["\u4EE3\u7406", b.proxy], ["\u5360\u7528", b.run ?? "\u2014"], ["\u9A8C\u8BC1\u7801\u65F6\u4FDD\u7559", "15 \u5206\u949F"], ["\u5386\u53F2", "\u4ECA\u5929 4 \u6B21\u8FD0\u884C \xB7 1 \u6B21\u8981\u4EBA\u767B\u5F55"]] })
        ] })
      ] })
    }
  );
}
function DesktopsPage({ onOpenRemote }) {
  const [sel, setSel] = (0, import_react.useState)("d1");
  const d = DESKTOPS.find((x) => x.id === sel);
  const tone = (s) => ({ on: "success", ready: "success", idle: "outline", off: "neutral", wait: "warning" })[s];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    PanelFrame,
    {
      title: "\u684C\u9762",
      help: "Windows \u7535\u8111\uFF1A\u624B\u52A8\u767B\u8BB0\u7684\u3001HeyAgent \u5F00\u7684\u865A\u62DF\u673A\uFF0C\u548C\u505A\u865A\u62DF\u673A\u7528\u7684\u6A21\u677F\u3002",
      actions: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", className: "ha-pillbtn", children: "\u505A\u6A21\u677F" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", className: "ha-pillbtn", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }), children: "\u65B0\u5EFA\u684C\u9762" })
      ] }),
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-split", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-list", children: ["\u684C\u9762", "\u6A21\u677F"].map((g) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-group", children: g }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-rows", children: DESKTOPS.filter((x) => x.group === g).map((x) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "ha-row" + (x.id === sel ? " ha-row-on" : ""), onClick: () => setSel(x.id), children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-glyph", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChecklistOutlineRegular, { size: 16 }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-row-main", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-row-title", children: x.name }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-meta", children: [
                x.kind,
                " \xB7 ",
                x.detail
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: tone(x.state), children: x.stateLabel })
          ] }, x.id)) })
        ] }, g)) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-detail-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-detail-title", children: d.name }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-meta", children: [
                d.kind,
                " \xB7 ",
                d.stateLabel,
                d.run ? ` \xB7 \u8FD0\u884C ${d.run}` : ""
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", onClick: onOpenRemote, children: "\u770B\u753B\u9762" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Section, { title: "\u8FD9\u53F0\u865A\u62DF\u673A", icon: import_dsh_client_ui_primitives.IconChecklistOutlineRegular, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fields, { rows: [["\u914D\u7F6E", d.detail], ["\u7CFB\u7EDF", "Windows 11 \u4E13\u4E1A\u7248 24H2"], ["\u8FDE\u63A5", "RDP \u6B63\u5E38 \xB7 \u81EA\u52A8\u5316\u670D\u52A1\u6B63\u5E38"]] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-btnrow", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", children: "\u5F00\u673A" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", children: "\u5173\u673A" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", children: "\u91CD\u542F" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconRefreshOutlineRegular, { size: 14 }), children: "\u91CD\u7F6E" })
            ] })
          ] })
        ] })
      ] })
    }
  );
}
function FakeBrowser({ compact, login, captcha }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-fb" + (compact ? " ha-fb-compact" : ""), children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-fb-bar", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "ha-fb-dots", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {})
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-fb-url", children: login ? "https://login.1688.com/member/signin.htm" : captcha ? "https://mobile.yangkeduo.com/verify" : "https://s.1688.com/selloffer/offer_search.htm?keywords=\u4E0D\u9508\u94A2\u4FDD\u6E29\u676F" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-fb-page", children: [
      login ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-fb-login", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-logo", children: "1688" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-input", children: "buyer01" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-input", children: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-btn", children: "\u767B\u5F55" })
      ] }) : captcha ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-fb-login", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-logo", children: "\u5B89\u5168\u9A8C\u8BC1" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-slider", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {}) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-meta", children: "\u5411\u53F3\u62D6\u52A8\u6ED1\u5757" })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-grid", children: ["\xA59.20 \xB7 \u4E49\u4E4C\u4E50\u4EAB\u676F\u4E1A", "\xA58.65 \xB7 \u6C38\u5EB7\u534E\u7F8E", "\xA510.40 \xB7 \u6D59\u6C5F\u987A\u53D1", "\xA57.90 \xB7 \u91D1\u534E\u94ED\u9014", "\xA511.20 \xB7 \u53F0\u5DDE\u6052\u6CF0", "\xA59.80 \xB7 \u5B81\u6CE2\u4F18\u54C1"].map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-fb-item", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-img" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ha-fb-cap", children: s })
      ] }, s)) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-fb-cursor", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: "16", height: "16", viewBox: "0 0 16 16", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M2 1l11 6-5 1.5L6 14z", fill: "currentColor" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          "agent \u5728\u505A\uFF1A",
          login ? "\u7B49\u4EBA\u767B\u5F55" : captcha ? "\u7B49\u4EBA\u8FC7\u9A8C\u8BC1\u7801" : "\u8BFB\u4EF7\u683C"
        ] })
      ] })
    ] })
  ] });
}
function RemoteViewTab() {
  const [mode, setMode] = (0, import_react.useState)("watch");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-rv", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-rv-banner", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconWarningOutlineRegular, { size: 14 }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u7B49\u4EBA\u5904\u7406\uFF1A1688 \u8981\u767B\u5F55\uFF08\u8981\u4EBA\u529E L-88\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", children: "\u5DF2\u5904\u7406\u597D\u4E86" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ha-rv-tools", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.SegmentedTabs, { size: "sm", label: "\u753B\u9762\u6A21\u5F0F", value: mode, onChange: setMode, items: [
        { value: "watch", label: "\u53EA\u770B", id: "ha-rv-w", panelId: "ha-rv-p" },
        { value: "control", label: "\u6211\u6765\u64CD\u4F5C", id: "ha-rv-c", panelId: "ha-rv-p" }
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-meta", children: "\u91C7\u8D2D-1 \xB7 R-1106-3 \xB7 \u5DF2\u8FDE\u63A5" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FakeBrowser, { login: true })
  ] });
}
function RunHeaderBadge({ onOpenRemote }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "ha-hdr", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "warning", children: "\u7B49\u4EBA\u5904\u7406 \xB7 \u5F85\u6279\u51C6" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ha-meta", children: "\u68C0\u67E5\u70B9 2/3" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", onClick: onOpenRemote, icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconGlobeOutlineRegular, { size: 14 }), children: "\u6D4F\u89C8\u5668\u753B\u9762" })
  ] });
}
function TabGuideIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconGlobeOutlineRegular, { size: 24 });
}

// src/toolviews.jsx
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime2 = require("react/jsx-runtime");
function toolArgs(block) {
  const raw = ("kind" in block ? block.call?.argsRaw : block.argsRaw) ?? "";
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function toolResult(block) {
  if (!("kind" in block)) return null;
  return (block.content ?? []).map((c) => c.type === "text" ? c.text : "").join("\n") || null;
}
var TOOL_META = {
  ask_human: { icon: import_dsh_client_ui_primitives2.IconUserOutlineRegular, label: "\u8981\u4EBA\u529E", card: true },
  checkpoint_mark: { icon: import_dsh_client_ui_primitives2.IconCheckCircleOutlineRegular, label: "\u68C0\u67E5\u70B9" },
  run_finish: { icon: import_dsh_client_ui_primitives2.IconDeliverDocRegular, label: "\u6536\u5C3E", card: true }
};
var HEYAGENT_TOOLVIEWS = Object.keys(TOOL_META);
function HeyAgentToolRow({ phase, block, toolName }) {
  const meta = TOOL_META[toolName] ?? { icon: import_dsh_client_ui_primitives2.IconCodeOutlineRegular, label: toolName };
  const Icon = meta.icon;
  const args = toolArgs(block);
  const result = toolResult(block);
  const running = phase !== "result";
  const failed = !running && block.isError === true;
  const desc = String(args.description ?? "");
  if (!meta.card) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "ha-tr", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Icon, { size: 14 }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "ha-tr-label", children: meta.label }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "ha-tr-dot" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "ha-tr-desc" + (running ? " ha-tr-run" : ""), children: desc.replace(/^检查点\s*/, "") }),
      !running && !failed ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Tag, { tone: "success", children: "\u8FBE\u6210" }) : null
    ] });
  }
  const tone = running ? "warning" : failed ? "danger" : "success";
  const state = toolName === "ask_human" ? running ? "\u7B49\u4EBA\u5904\u7406" : failed ? "\u6CA1\u5904\u7406" : "\u5DF2\u5904\u7406" : running ? "\u6536\u5C3E\u4E2D" : "\u529E\u6210 \xB7 \u590D\u6838\u4E2D";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "ha-tcard", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "ha-tcard-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Icon, { size: 16 }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "ha-tr-label", children: meta.label }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "ha-tcard-title", children: desc }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Tag, { tone, children: state })
    ] }),
    toolName === "ask_human" && args.question ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "ha-tcard-q", children: args.question }) : null,
    toolName === "run_finish" && args.summary ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "ha-tcard-q", children: args.summary }) : null,
    result ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "ha-tcard-r", children: result }) : null,
    toolName === "ask_human" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "ha-tcard-meta", children: "\u8981\u4EBA\u529E L-88 \xB7 \u5206\u7ED9 \u91C7\u8D2D\u7EC4 \xB7 \u6D4F\u89C8\u5668 \u91C7\u8D2D-1" }) : null
  ] });
}

// src/styles.css
var styles_default = "/* HeyAgent mock panels. Only dsh --dsw-* tokens; geometry copied from\n   ui-schedule TaskManagerPage / ui-plugin-manager (960px column, 28px heading,\n   R12 rows, 0.5px hairlines). */\n.ha-brandname { font-size: 18px; line-height: 24px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-primary); }\n.ha-panelicon { position: relative; display: inline-flex; }\n.ha-badge { position: absolute; top: -5px; right: -8px; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 999px; background: var(--dsw-alias-state-warn-primary); color: #fff; font-size: 10px; line-height: 14px; font-style: normal; font-weight: 600; text-align: center; }\n\n.ha-page { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; scrollbar-gutter: stable; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.6; }\n.ha-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 28px clamp(24px, 4vw, 48px) 0; margin-bottom: 20px; max-width: 1200px; width: 100%; box-sizing: border-box; margin-inline: auto; }\n.ha-head h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; display: flex; align-items: center; gap: 8px; }\n.ha-help { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1; font-weight: 500; cursor: help; }\n.ha-actions { display: flex; align-items: center; gap: 12px; }\n.ha-pillbtn { height: 32px; font-size: 13px; border-radius: 16px; padding: 0 12px; }\n.ha-body { padding: 0 clamp(24px, 4vw, 48px) 48px; max-width: 1200px; width: 100%; box-sizing: border-box; margin-inline: auto; flex: 1; min-height: 0; }\n.ha-split { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 24px; align-items: start; }\n@media (max-width: 900px) { .ha-split { grid-template-columns: 1fr; } }\n.ha-list { display: flex; flex-direction: column; gap: 12px; min-width: 0; }\n.ha-chips { display: flex; gap: 8px; flex-wrap: wrap; }\n.ha-chip { height: 28px; padding: 0 10px; border: 0; border-radius: 14px; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; }\n.ha-chip:hover, .ha-chip-on { background: var(--dsw-alias-interactive-bg-hover); }\n.ha-chip-on { color: var(--dsw-alias-label-primary); }\n.ha-search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; color: var(--dsw-alias-label-tertiary); box-sizing: border-box; }\n.ha-search:focus-within { border-color: var(--dsw-alias-state-business-primary); }\n.ha-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font: inherit; color: var(--dsw-alias-label-primary); }\n.ha-search input::placeholder { color: var(--dsw-alias-label-caption); }\n.ha-rows { display: flex; flex-direction: column; gap: 2px; }\n.ha-row { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 8px; border: 0; border-radius: 12px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; box-sizing: border-box; }\n.ha-row:hover, .ha-row-on { background: var(--dsw-alias-interactive-bg-hover); }\n.ha-row-flat { cursor: default; align-items: center; padding: 6px 4px; }\n.ha-row-flat:hover { background: transparent; }\n.ha-glyph { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 20px; margin-top: 2px; color: var(--dsw-alias-label-tertiary); }\n.ha-row-main { flex: 1; min-width: 0; }\n.ha-row-title { line-height: 23px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.ha-meta { font-size: 13px; line-height: 21px; color: var(--dsw-alias-label-tertiary); font-weight: 400; }\n.ha-group { font-size: 13px; color: var(--dsw-alias-label-tertiary); padding: 8px 8px 4px; }\n.ha-detail { display: flex; flex-direction: column; gap: 16px; min-width: 0; padding: 20px 24px 24px; border-radius: 20px; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4)); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); }\n.ha-detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }\n.ha-detail-title { font-size: 16px; line-height: 24px; font-weight: 500; }\n.ha-lead { margin: 0; color: var(--dsw-alias-label-secondary); }\n.ha-p { margin: 0; color: var(--dsw-alias-label-secondary); }\n.ha-empty { color: var(--dsw-alias-label-tertiary); text-align: center; padding: 48px 20px; }\n.ha-dl { margin: 0; display: grid; gap: 0; }\n.ha-dl > div { display: grid; grid-template-columns: 96px 1fr; gap: 12px; padding: 8px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }\n.ha-dl > div:first-child { border-top: 0; }\n.ha-dl dt { color: var(--dsw-alias-label-tertiary); font-size: 13px; }\n.ha-dl dd { margin: 0; }\n.ha-btnrow { display: flex; flex-wrap: wrap; gap: 8px; }\n.ha-tight { gap: 8px; }\n.ha-textarea { min-height: 72px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; resize: vertical; }\n.ha-tabs { max-width: 420px; }\n.ha-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 16px; border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-base); }\n.ha-card-head { display: flex; align-items: center; gap: 6px; font-weight: 500; color: var(--dsw-alias-label-primary); }\n.ha-card-head svg { color: var(--dsw-alias-label-tertiary); }\n.ha-structure { display: flex; flex-direction: column; gap: 12px; }\n.ha-loop { position: relative; padding: 28px 12px 12px; border: 1px dashed var(--dsw-alias-border-l4); border-radius: 20px; }\n.ha-loop-label { position: absolute; top: 6px; left: 14px; font-size: 12px; color: var(--dsw-alias-state-business-primary); }\n.ha-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }\n.ha-ol, .ha-ul { margin: 0; padding-left: 20px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 22px; }\n.ha-tags { display: flex; flex-wrap: wrap; gap: 6px; }\n.ha-hdr { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }\n\n/* placeholder remote view */\n.ha-shot-wrap { max-width: 560px; }\n.ha-fb { border-radius: 12px; overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); }\n.ha-fb-bar { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 10px; background: var(--dsw-alias-bg-module-platform); border-bottom: 0.5px solid var(--dsw-alias-border-l2); }\n.ha-fb-dots { display: inline-flex; gap: 5px; }\n.ha-fb-dots i { width: 8px; height: 8px; border-radius: 999px; background: var(--dsw-alias-label-dimmed); }\n.ha-fb-url { flex: 1; min-width: 0; height: 22px; padding: 0 10px; border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.ha-fb-page { position: relative; min-height: 260px; padding: 16px; }\n.ha-fb-compact .ha-fb-page { min-height: 200px; }\n.ha-fb-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }\n.ha-fb-img { aspect-ratio: 4 / 3; border-radius: 8px; background: linear-gradient(135deg, var(--dsw-alias-interactive-bg-active), var(--dsw-alias-interactive-bg-hover)); }\n.ha-fb-cap { font-size: 12px; line-height: 18px; margin-top: 4px; color: var(--dsw-alias-label-secondary); }\n.ha-fb-login { display: flex; flex-direction: column; gap: 10px; width: 220px; margin: 16px auto; }\n.ha-fb-logo { font-size: 20px; font-weight: 600; color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); text-align: center; }\n.ha-fb-input { height: 30px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; line-height: 30px; font-size: 13px; color: var(--dsw-alias-label-secondary); }\n.ha-fb-btn { height: 32px; border-radius: 8px; background: var(--dsw-alias-state-warn-primary); color: #fff; text-align: center; line-height: 32px; font-size: 13px; }\n.ha-fb-slider { height: 32px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); position: relative; }\n.ha-fb-slider span { position: absolute; left: 2px; top: 2px; width: 44px; height: 28px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-elevation-soft); }\n.ha-fb-cursor { position: absolute; left: 38%; top: 46%; display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-state-business-primary); }\n.ha-fb-cursor span { padding: 1px 8px; border-radius: 999px; background: var(--dsw-alias-state-business-primary); color: #fff; font-size: 11px; line-height: 17px; white-space: nowrap; }\n.ha-rv { display: flex; flex-direction: column; gap: 10px; padding: 12px; height: 100%; box-sizing: border-box; overflow: auto; }\n.ha-rv-banner { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 12px; background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-label-primary); font-size: 13px; }\n.ha-rv-banner > span { flex: 1; }\n.ha-rv-banner svg { color: var(--dsw-alias-state-warn-primary); }\n.ha-rv-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; }\n.ha-rv-tools > :first-child { width: 200px; }\n/* business tool rows inside dsh's chat process list */\n.ha-tr { display: flex; align-items: center; gap: 6px; min-height: 24px; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-tertiary); }\n.ha-tr svg { color: var(--dsw-alias-state-success-primary); flex: none; }\n.ha-tr-label { color: var(--dsw-alias-label-secondary); font-weight: 500; flex: none; }\n.ha-tr-dot { width: 2px; height: 2px; border-radius: 999px; background: var(--dsw-alias-label-caption); margin: 0 2px; flex: none; }\n.ha-tr-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.ha-tr-run { color: var(--dsw-alias-label-deep-diving, var(--dsw-alias-label-tertiary)); }\n.ha-tcard { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; padding: 10px 14px; border-radius: 16px; border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1)); box-shadow: var(--dsw-shadow-lv2, none); font-size: 13px; line-height: 20px; }\n.ha-tcard-head { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary); }\n.ha-tcard-head svg { color: var(--dsw-alias-state-warn-primary); flex: none; }\n.ha-tcard-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.ha-tcard-q { color: var(--dsw-alias-label-secondary); }\n.ha-tcard-r { padding: 6px 10px; border-radius: 10px; background: var(--dsw-alias-markdown-tag, var(--dsw-alias-interactive-bg-hover)); color: var(--dsw-alias-label-primary); }\n.ha-tcard-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); }\n.ha-goat { display: block; border-radius: 6px; }\n.ha-goat-hero { display: block; border-radius: 10px; }\n";

// src/logo.b64
var logo_default = "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";

// src/client.jsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var LOGO = `data:image/png;base64,${logo_default.trim()}`;
var REMOTE_ID = "heyagent-ui/remote-view";
var REMOTE_KIND = "heyagentRemoteView";
var inject = ["slots", "layout", "sidebarRightTabs", "sidebarRight", "uiWorkspace"];
function GoatMark({ size }) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("img", { src: LOGO, width: size ?? 24, height: size ?? 24, alt: "", className: "ha-goat" });
}
function HeroMark() {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("img", { src: LOGO, width: 40, height: 40, alt: "", className: "ha-goat-hero" });
}
function BrandName() {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "ha-brandname", children: "HeyAgent" });
}
var iconOf = (Icon) => function PanelIcon({ size }) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Icon, { size });
};
function InboxIcon({ size }) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "ha-panelicon", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives3.IconWarningOutlineRegular, { size }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("i", { className: "ha-badge", children: "5" })
  ] });
}
function apply(ctx) {
  ctx.effect(() => {
    const el = document.createElement("style");
    el.dataset.heyagent = "ui";
    el.textContent = styles_default;
    document.head.appendChild(el);
    return () => el.remove();
  }, "heyagent-ui: styles");
  ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark", priority: -10 }, GoatMark));
  ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name", priority: -10 }, BrandName));
  ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark", priority: -10 }, HeroMark));
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: REMOTE_ID,
    kind: REMOTE_KIND,
    priority: "extension",
    title: () => "\u6D4F\u89C8\u5668\u753B\u9762",
    guide: [{ id: "remote", order: 5, title: () => "\u6D4F\u89C8\u5668\u753B\u9762", description: () => "\u770B\u8FD9\u6B21\u8FD0\u884C\u7684 Chrome\uFF0C\u7B49\u4EBA\u5904\u7406\u65F6\u63A5\u624B", icon: TabGuideIcon }]
  }), "heyagent-ui: remote view tab type");
  ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: REMOTE_ID }, RemoteViewTab));
  const openRemote = () => {
    try {
      ctx.sidebarRight.openTab(REMOTE_KIND, {});
    } catch (e) {
      console.warn("[heyagent-ui] openTab", e);
    }
  };
  const openRun = () => ctx.layout.selectPanel(null);
  const newRun = () => {
    ctx.layout.selectPanel(null);
    try {
      ctx.uiWorkspace.startSession(void 0, { prompt: "\u8DD1\u4E00\u6B21\u6BCF\u65E5\u6BD4\u4EF7\uFF1A\u4E0D\u9508\u94A2\u4FDD\u6E29\u676F 500ml", whenDraftExists: "append" });
    } catch (e) {
      console.warn(e);
    }
  };
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: "heyagent-run-status",
    order: -20,
    inject: () => ({ onOpenRemote: openRemote })
  }, RunHeaderBadge));
  for (const key of HEYAGENT_TOOLVIEWS) {
    ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name: "tool.call.toolview", key }, HeyAgentToolRow));
  }
  const panels = [
    ["heyagent-inbox", "\u8981\u4EBA\u529E", 1, InboxIcon, InboxPage, { onOpenRun: openRun, onOpenRemote: () => {
      openRun();
      setTimeout(openRemote, 300);
    } }],
    ["heyagent-tasks", "\u4EFB\u52A1", 2, iconOf(import_dsh_client_ui_primitives3.IconChecklistOutlineRegular), TasksPage, { onNewRun: newRun }],
    ["heyagent-browsers", "\u6D4F\u89C8\u5668", 4, iconOf(import_dsh_client_ui_primitives3.IconGlobeOutlineRegular), BrowsersPage, { onOpenRemote: () => {
      openRun();
      setTimeout(openRemote, 300);
    } }],
    ["heyagent-desktops", "\u684C\u9762", 5, iconOf(import_dsh_client_ui_primitives3.IconCodeOutlineRegular), DesktopsPage, { onOpenRemote: () => {
    } }]
  ];
  for (const [id, label, order, Icon, Page, injected] of panels) {
    ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: id, inject: () => injected }, Page));
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id, order: -100 + order, label: () => label }, Icon));
  }
}

return module.exports; } });
