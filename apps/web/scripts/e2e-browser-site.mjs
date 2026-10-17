#!/usr/bin/env node
// 浏览器端到端用的本地测试页（只给 e2e-browser.mjs 用）：一个「安全验证」页，人要在远程画面里输入一句话、点按钮才能过。
// 由 e2e-browser.mjs 用 podman 起在整套 pod 里（和 worker 共用网络），只监听 127.0.0.1，外面访问不到。
//   /captcha  标题「安全验证」（验证码检测会认出来）。输入框里填对「人类ok」再点按钮，网页弹 confirm，确定后写 cookie 跳到 /secret
//   /secret   过了验证才看得到暗号（暗号由环境变量 CODE 给，每次运行不一样）
//   ?k=xxx    同一个 Chrome 配置要测好几轮时用：每一轮的「过了验证」cookie 名字不一样（登录态会写回保险箱，下一轮还带着）
// 输入框和按钮放在固定位置（页面 CSS 像素），测试按这个位置在远程画面上点。
import { createServer } from "node:http"

const PORT = Number(process.env.PORT ?? 8099)
const CODE = process.env.CODE ?? "蓝色海豚"
export const ANSWER = "人类ok"

const html = (title, body) =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:16px sans-serif;margin:0}#answer{position:absolute;left:40px;top:150px;width:300px;height:40px;font-size:18px}` +
  `#human{position:absolute;left:40px;top:220px;width:300px;height:80px;font-size:18px}#tip{position:absolute;left:40px;top:320px}</style>` +
  `</head><body>${body}</body></html>`

const cookieName = (round) => (round ? `passed_${round.replace(/[^a-z0-9]/gi, "")}` : "passed")
const passed = (req, round) => (req.headers.cookie ?? "").split(/;\s*/).includes(`${cookieName(round)}=1`)

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://site")
  const path = url.pathname
  const round = url.searchParams.get("k") ?? ""
  const query = round ? `?k=${encodeURIComponent(round)}` : ""
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers })
    res.end(body)
  }
  if (path === "/captcha") {
    if (passed(req, round)) return send(302, "", { location: `/secret${query}` })
    return send(
      200,
      html(
        "安全验证",
        `<h1 style="margin:24px 40px 8px">请完成安全验证</h1><p style="margin:0 40px">在下面的框里输入「${ANSWER}」，再点按钮。</p>` +
          `<input id="answer" autocomplete="off"><button id="human">我不是机器人</button><p id="tip"></p>` +
          `<script>document.getElementById("human").onclick=()=>{if(!confirm("确定你不是机器人？"))return;const v=document.getElementById("answer").value.trim();` +
          `if(v===${JSON.stringify(ANSWER)}){document.cookie=${JSON.stringify(`${cookieName(round)}=1; path=/; max-age=86400`)};location.href=${JSON.stringify(`/secret${query}`)}}else{document.getElementById("tip").textContent="不对："+v}}</script>`
      )
    )
  }
  if (path === "/secret") {
    if (!passed(req, round)) return send(302, "", { location: `/captcha${query}` })
    return send(200, html("通过了", `<h1 style="margin:24px 40px">通过了</h1><p id="code" style="margin:0 40px">暗号：${CODE}</p>`))
  }
  send(404, html("找不到", "<p>找不到</p>"))
}).listen(PORT, "127.0.0.1", () => console.log(`e2e 测试页已启动：http://127.0.0.1:${PORT}/captcha`))
