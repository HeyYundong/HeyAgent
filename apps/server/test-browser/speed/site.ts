// 浏览器提速的基准站点（docs/dev/browser-speed.md）：三个贴近日常工作的场景，服务器端记下 agent 做的结果、自己判对错。
// A 照着资料录表单（8 个商品，有公告弹窗、保存成功弹窗挡着）；
// B 搜索后汇总（查 6 家供应商的电话和评分，页面上有一张加载很慢的图）；
// C 复制图片粘进文档（A–F 每个字母搜图、复制、粘进对应的格，像 R-1-2 把字母图放进金山文档）；
// D 采购需求配商品（要看内容判断）；
// E 和 B 一样查几项交汇总，但列表是前端翻页、由 JSON 接口加载（docs/dev/solidify.md 19.11、第 21 节）：
//   /e/list 给登录 cookie（HttpOnly），页面脚本调 /e/api/items?page=n&size=8（要 cookie）一页页加载；
//   库存列由只认 token 的 /e/api/stock 加载（页面脚本把 token 放进 Authorization，不带 cookie），看固化员给不给 HTTP 工具建议；
// F 和 E 同一个站点，但还要查库存：库存只有 token 接口给，browser.fetch 调不了，脚本得照页面翻页读，固化员应该建议建 HTTP 工具。
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import sharp from "sharp"

export const HOST = "bench.localhost"
/** 慢资源：页面主体早就出来了，这张图要等这么久（像谷歌图片、带广告的网页一直在加载） */
export const SLOW_MS = 4000

export const PRODUCTS = [
  { code: "P-101", name: "不锈钢保温杯 500ml", price: "23.50", moq: "200", category: "厨房用品", tax: true },
  { code: "P-102", name: "硅胶折叠水壶", price: "18.00", moq: "300", category: "户外用品", tax: false },
  { code: "P-103", name: "竹纤维毛巾套装", price: "31.80", moq: "150", category: "家纺", tax: true },
  { code: "P-104", name: "LED 感应夜灯", price: "12.90", moq: "500", category: "灯具", tax: true },
  { code: "P-105", name: "陶瓷咖啡杯", price: "15.60", moq: "240", category: "厨房用品", tax: false },
  { code: "P-106", name: "防水登山背包 30L", price: "89.00", moq: "80", category: "户外用品", tax: true },
  { code: "P-107", name: "记忆棉枕头", price: "46.50", moq: "120", category: "家纺", tax: false },
  { code: "P-108", name: "太阳能庭院灯", price: "27.30", moq: "260", category: "灯具", tax: true },
]
const CATEGORIES = ["厨房用品", "户外用品", "家纺", "灯具", "办公用品"]

export const SUPPLIERS = [
  { id: "s1", name: "义乌市晨光日用品有限公司", contact: "陈晓", phone: "0579-85512301", rating: "4.6", city: "义乌" },
  { id: "s2", name: "义乌市晨辉日用品商行", contact: "王丽", phone: "0579-85519922", rating: "3.9", city: "义乌" },
  { id: "s3", name: "永康市铭泰五金制品厂", contact: "李强", phone: "0579-87120456", rating: "4.8", city: "永康" },
  { id: "s4", name: "永康市铭达五金工具店", contact: "赵敏", phone: "0579-87128830", rating: "4.1", city: "永康" },
  { id: "s5", name: "深圳市光源照明科技有限公司", contact: "周杰", phone: "0755-26651188", rating: "4.4", city: "深圳" },
  { id: "s6", name: "深圳市光宇照明电器厂", contact: "吴芳", phone: "0755-26659021", rating: "3.7", city: "深圳" },
  { id: "s7", name: "南通市家和纺织品有限公司", contact: "郑伟", phone: "0513-85563370", rating: "4.7", city: "南通" },
  { id: "s8", name: "南通市家悦家纺店", contact: "孙娜", phone: "0513-85567712", rating: "4.0", city: "南通" },
  { id: "s9", name: "潮州市瓷韵陶瓷有限公司", contact: "黄磊", phone: "0768-62230915", rating: "4.5", city: "潮州" },
  { id: "s10", name: "潮州市瓷源陶瓷工艺厂", contact: "林静", phone: "0768-62238844", rating: "4.2", city: "潮州" },
  { id: "s11", name: "泉州市远行户外用品有限公司", contact: "何勇", phone: "0595-22718806", rating: "4.3", city: "泉州" },
  { id: "s12", name: "泉州市远航箱包厂", contact: "高原", phone: "0595-22713359", rating: "3.8", city: "泉州" },
]
/** 要查的 6 家（任务里给的是全名） */
export const TARGET_SUPPLIERS = ["s1", "s3", "s5", "s7", "s9", "s11"]

export const LETTERS = ["A", "B", "C", "D", "E", "F"]
/** 每个字母搜出来的 6 张图：只有一张是「大写字母 X」，其余是干扰图；每张图尺寸不同，贴进文档后按尺寸认是哪张 */
function letterImages(letter: string) {
  const index = LETTERS.indexOf(letter)
  const other = LETTERS[(index + 1) % LETTERS.length]!
  const alts = [`小写字母 ${letter.toLowerCase()}`, `大写字母 ${other}`, `大写字母 ${letter}`, `字母 ${letter} 形状的饼干`, `数字 ${index + 1}`, `带字母 ${letter} 的车牌`]
  return alts.map((alt, variant) => ({ id: `${letter}${variant}`, alt, width: 120 + index * 10 + variant, height: 90 + variant * 4, correct: variant === 2 }))
}

/** D：采购需求配商品，要看内容判断（docs/dev/solidify.md 18.2 的判断题）。目录 10 个商品 */
export const CATALOG = [
  { code: "D-01", name: "不锈钢保温杯 500ml", note: "双层真空，保温 12 小时，适合通勤" },
  { code: "D-02", name: "儿童保温杯 350ml", note: "带硅胶防摔套，只有 220 克，户外用" },
  { code: "D-03", name: "陶瓷咖啡杯", note: "可以放进洗碗机和微波炉" },
  { code: "D-04", name: "双层玻璃咖啡杯", note: "透明，看得见咖啡，只能手洗" },
  { code: "D-05", name: "记忆棉 U 型枕", note: "托住脖子，午休、坐车用" },
  { code: "D-06", name: "荞麦壳枕头", note: "偏硬、透气，夜里睡觉用" },
  { code: "D-07", name: "太阳能庭院灯", note: "白天晒太阳充电，天黑自动亮，不用接电线" },
  { code: "D-08", name: "LED 落地灯", note: "插电，放在地上，亮度可调，适合看书" },
  { code: "D-09", name: "折叠硅胶水壶 600ml", note: "不用时压扁，不保温" },
  { code: "D-10", name: "运动水壶 1.5L", note: "大容量，塑料，不保温" },
]
/** 需求池：每次 reset 换一组 4 条（脚本不能把上次的答案写死）；want 是该选的商品 */
const NEEDS = [
  { text: "周末带孩子去露营，想给孩子带热水，杯子要轻、摔了不坏", want: "D-02" },
  { text: "公司午休趴在桌上睡，脖子疼，想买个午休用的", want: "D-05" },
  { text: "院子里晚上太黑，想装个灯，但不想拉电线", want: "D-07" },
  { text: "新买了洗碗机，想换一批能直接放进去洗的咖啡杯", want: "D-03" },
  { text: "冬天上班路上想喝热茶，要能装 500 毫升左右", want: "D-01" },
  { text: "去健身房一次要喝很多水，想要个装得多的水壶", want: "D-10" },
  { text: "出差行李箱空间小，想带个不用时能压扁的水壶", want: "D-09" },
  { text: "在卧室沙发边看书，想要个放地上的灯", want: "D-08" },
  { text: "睡觉喜欢硬一点、透气的枕头", want: "D-06" },
  { text: "办公室喝咖啡，想要透明的杯子能看到拉花，手洗没关系", want: "D-04" },
]
/** 第 round 组的 4 条需求（编号 R1–R4） */
export function needsOf(round: number) {
  return [0, 1, 2, 3].map((k) => ({ id: `R${k + 1}`, ...NEEDS[(round * 4 + k) % NEEDS.length]! }))
}

/** E：40 个商品，每样有标准款、加大款两种（名字只差一个词，分在不同的页上），每页 8 个，共 5 页 */
const E_BASES = ["不锈钢保温杯", "硅胶折叠水壶", "竹纤维毛巾", "LED 感应夜灯", "陶瓷咖啡杯", "登山背包", "记忆棉枕头", "太阳能庭院灯", "玻璃储物罐", "帆布收纳箱", "木质砧板", "电动牙刷头", "无线鼠标", "笔记本支架", "桌面风扇", "瑜伽垫", "折叠雨伞", "落地晾衣架", "保鲜盒套装", "不粘煎锅"]
export const E_ITEMS = Array.from({ length: 40 }, (_, i) => {
  const base = i % 20
  const large = i >= 20
  return {
    code: `E-${String(i + 1).padStart(3, "0")}`,
    name: `${E_BASES[base]}（${large ? "加大款" : "标准款"}）`,
    price: (12 + base * 3.7 + (large ? 6.5 : 0)).toFixed(2),
    supplier: SUPPLIERS[(i * 5) % SUPPLIERS.length]!.name,
    stock: 100 + ((i * 37) % 500),
  }
})
export const E_PAGE_SIZE = 8
/** 要查的 6 个（分在第 1、2、3、4、4、5 页；另一款都在别的页上） */
export const E_TARGETS = ["E-003", "E-012", "E-018", "E-025", "E-031", "E-040"]
/** 页面脚本放进 Authorization 的 token（只认它，不认 cookie） */
const E_TOKEN = "bench-stock-token-7f3a91"
const E_SESSION = "bench-session-e"

export type SpeedScenario = "A" | "B" | "C" | "D" | "E" | "F"

export interface SpeedResults {
  /** A：每个编号最后一次提交的内容 */
  products: Map<string, Record<string, string>>
  productSubmits: number
  /** B：提交的汇总（最后一次） */
  report?: string
  /** C：每行最后贴进去的图（尺寸） */
  pasted: Map<string, { width: number; height: number }>
  pasteCount: number
  /** D：现在是第几组需求（每次 reset 换下一组）、每条需求最后下单的商品 */
  needsRound: number
  orders: Map<string, string>
  orderSubmits: number
  /** E：两个接口各被调了几次（看脚本是不是改用接口） */
  eHits: { list: number; items: number; stock: number; unauthorized: number }
}

export interface SpeedSite {
  port: number
  url(path: string): string
  results: SpeedResults
  reset(): void
  close(): Promise<void>
}

const page = (title: string, body: string, extra = "") =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title><style>
body{font-family:sans-serif;margin:16px} table{border-collapse:collapse} td,th{border:1px solid #999;padding:4px 8px}
.mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:10}
.box{background:#fff;padding:24px;min-width:320px} label{display:block;margin:6px 0}
.cookie{position:fixed;left:0;right:0;bottom:0;height:45vh;background:#222;color:#fff;padding:16px;z-index:5}
.grid img{margin:6px;border:1px solid #ccc} .cell{width:220px;min-height:60px;border:1px dashed #888}
</style>${extra}</head><body>${body}</body></html>`

const slowImg = (tag: string) => `<img alt="" src="/slow.gif?${tag}" width="1" height="1">`

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => resolve(new URLSearchParams(body)))
  })
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>)
      } catch {
        resolve({})
      }
    })
  })
}

const cookieOf = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1]

const productForm = () => `<h1>新建商品</h1>
<form method="post" action="/a/new">
<label>编号 <input name="code"></label>
<label>名称 <input name="name"></label>
<label>单价（元） <input name="price"></label>
<label>起订量 <input name="moq"></label>
<label>类目 <select name="category"><option value="">请选择</option>${CATEGORIES.map((each) => `<option>${each}</option>`).join("")}</select></label>
<label><input type="checkbox" name="tax" value="1"> 含税</label>
<button type="submit">提交</button>
</form>
<p><a href="/a/list">已录入的商品</a></p>`

export async function startSpeedSite(): Promise<SpeedSite> {
  const results: SpeedResults = { products: new Map(), productSubmits: 0, pasted: new Map(), pasteCount: 0, needsRound: 0, orders: new Map(), orderSubmits: 0, eHits: { list: 0, items: 0, stock: 0, unauthorized: 0 } }
  const images = new Map<string, Buffer>()
  for (const letter of LETTERS)
    for (const image of letterImages(letter)) {
      const shade = 60 + LETTERS.indexOf(letter) * 25
      images.set(image.id, await sharp({ create: { width: image.width, height: image.height, channels: 3, background: { r: shade, g: 120, b: 200 - shade / 2 } } }).png().toBuffer())
    }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers })
      res.end(body)
    }
    const path = url.pathname
    if (path === "/slow.gif") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" })
        res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"))
      }, SLOW_MS)
      return
    }

    // ---------- A 录表单 ----------
    if (path === "/a/products")
      return send(
        200,
        page(
          "待录入商品",
          `<h1>待录入商品（共 ${PRODUCTS.length} 个）</h1><table><tr><th>编号</th><th>名称</th><th>单价（元）</th><th>起订量</th><th>类目</th><th>含税</th></tr>${PRODUCTS.map(
            (each) => `<tr><td>${each.code}</td><td>${each.name}</td><td>${each.price}</td><td>${each.moq}</td><td>${each.category}</td><td>${each.tax ? "是" : "否"}</td></tr>`
          ).join("")}</table>`
        )
      )
    if (path === "/a/new") {
      if (req.method === "POST") {
        void readForm(req).then((form) => {
          const code = (form.get("code") ?? "").trim()
          results.productSubmits++
          results.products.set(code, { name: (form.get("name") ?? "").trim(), price: (form.get("price") ?? "").trim(), moq: (form.get("moq") ?? "").trim(), category: form.get("category") ?? "", tax: form.get("tax") ? "1" : "" })
          send(303, "", { location: `/a/new?saved=${encodeURIComponent(code)}` })
        })
        return
      }
      // 真的存过才提示「已保存」（以前只看网址参数：复核发现 ?saved=P-999 也弹，就不认这个提示了）
      const saved = url.searchParams.get("saved")
      const notice = cookieOf(req, "notice") !== "seen"
      const overlay = saved && results.products.has(saved)
        ? `<div class="mask" id="savedMask"><div class="box" role="dialog" aria-label="保存成功"><p>已保存商品 ${saved}。</p><button onclick="document.getElementById('savedMask').remove()">继续录入</button></div></div>`
        : notice
          ? `<div class="mask" id="noticeMask"><div class="box" role="dialog" aria-label="系统公告"><h2>系统公告</h2><p>本周六 22:00 起系统维护两小时，请提前保存数据。</p><button onclick="document.cookie='notice=seen; path=/'; document.getElementById('noticeMask').remove()">我知道了</button></div></div>`
          : ""
      return send(200, page("新建商品 - ERP", productForm() + overlay))
    }
    if (path === "/a/list")
      return send(
        200,
        page(
          "已录入的商品 - ERP",
          `<h1>已录入的商品（共 ${results.products.size} 个）</h1><table><tr><th>编号</th><th>名称</th><th>单价（元）</th><th>起订量</th><th>类目</th><th>含税</th></tr>${[...results.products.entries()]
            .map(([code, each]) => `<tr><td>${code}</td><td>${each.name}</td><td>${each.price}</td><td>${each.moq}</td><td>${each.category}</td><td>${each.tax ? "是" : "否"}</td></tr>`)
            .join("")}</table><p><a href="/a/new">继续录入</a></p>`
        )
      )

    // ---------- B 搜索汇总 ----------
    if (path === "/b/search") {
      const q = (url.searchParams.get("q") ?? "").trim()
      const hits = q ? SUPPLIERS.filter((each) => each.name.includes(q) || q.includes(each.name)) : []
      return send(
        200,
        page(
          "供应商搜索",
          `<h1>供应商搜索</h1><form method="get" action="/b/search"><input name="q" aria-label="搜索供应商" value="${q.replace(/"/g, "&quot;")}"> <button type="submit">搜索</button></form>${
            q ? `<p>找到 ${hits.length} 家</p><ul>${hits.map((each) => `<li><a href="/b/s/${each.id}">${each.name}</a>（${each.city}）</li>`).join("")}</ul>` : ""
          }${slowImg(`b-search-${q}`)}`
        )
      )
    }
    if (path.startsWith("/b/s/")) {
      const supplier = SUPPLIERS.find((each) => each.id === path.slice(5))
      if (!supplier) return send(404, page("没有这家", "<p>没有这家供应商</p>"))
      return send(
        200,
        page(
          supplier.name,
          `<h1>${supplier.name}</h1><table><tr><th>联系人</th><td>${supplier.contact}</td></tr><tr><th>电话</th><td>${supplier.phone}</td></tr><tr><th>评分</th><td>${supplier.rating}</td></tr><tr><th>所在地</th><td>${supplier.city}</td></tr></table><p><a href="/b/search">返回搜索</a></p>${slowImg(`b-${supplier.id}`)}`
        )
      )
    }
    if (path === "/b/report") {
      if (req.method === "POST") {
        void readForm(req).then((form) => {
          results.report = form.get("lines") ?? ""
          send(200, page("已提交", "<p>汇总已提交，谢谢。</p>"))
        })
        return
      }
      return send(
        200,
        page("提交汇总", `<h1>提交汇总</h1><form method="post" action="/b/report"><label>汇总（每行一家：名称,电话,评分） <textarea name="lines" rows="8" cols="60"></textarea></label><button type="submit">提交</button></form>`)
      )
    }

    // ---------- C 图片粘贴 ----------
    if (path === "/c/search") {
      const q = (url.searchParams.get("q") ?? "").trim()
      const letter = /letter\s+([A-F])\b/i.exec(q)?.[1]?.toUpperCase()
      const list = letter ? letterImages(letter) : []
      const cookie = cookieOf(req, "consent") !== "yes"
      return send(
        200,
        page(
          `${q} - 图片搜索`,
          `<h1>图片搜索</h1><form method="get" action="/c/search"><input name="q" aria-label="搜索图片" value="${q.replace(/"/g, "&quot;")}"> <button type="submit">搜索</button></form>
<div class="grid">${list.map((each) => `<img src="/c/img/${each.id}.png" alt="${each.alt}" width="${each.width}" height="${each.height}">`).join("")}</div>
${cookie ? `<div class="cookie" id="cookieBar" role="dialog" aria-label="Cookie 提示"><p>本站使用 Cookie 改善体验。</p><button onclick="document.cookie='consent=yes; path=/'; document.getElementById('cookieBar').remove()">接受</button></div>` : ""}${slowImg(`c-${q}`)}`
        )
      )
    }
    if (path.startsWith("/c/img/")) {
      const data = images.get(path.slice(7).replace(/\.png$/, ""))
      if (!data) return send(404, "")
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" })
      return res.end(data)
    }
    if (path === "/c/doc")
      return send(
        200,
        page(
          "字母图片表 - 在线文档",
          `<h1>字母图片表</h1><table><tr><th>字母</th><th>图片</th></tr>${LETTERS.map(
            // 和真的在线文档一样：贴过的图存着，重新打开还在
            (letter) => {
              const saved = results.pasted.get(letter)
              const img = saved ? `<img alt="已贴的图 ${saved.width}×${saved.height}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="80">` : ""
              return `<tr><td>${letter}</td><td><div class="cell" contenteditable="true" data-row="${letter}" aria-label="字母 ${letter} 的图片格">${img}</div></td></tr>`
            }
          ).join("")}</table>
<script>
document.querySelectorAll('.cell').forEach((cell) => cell.addEventListener('paste', async (event) => {
  event.preventDefault()
  const file = [...event.clipboardData.files].find((each) => each.type.startsWith('image/'))
  if (!file) return
  const bitmap = await createImageBitmap(file)
  const img = document.createElement('img'); img.src = URL.createObjectURL(file); img.alt = '已贴的图 ' + bitmap.width + '×' + bitmap.height; img.width = 80
  cell.replaceChildren(img)
  await fetch('/c/pasted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ row: cell.dataset.row, width: bitmap.width, height: bitmap.height }) })
}))
</script>`
        )
      )
    if (path === "/c/pasted" && req.method === "POST") {
      void readJson(req).then((body) => {
        results.pasteCount++
        if (typeof body.row === "string") results.pasted.set(body.row, { width: Number(body.width), height: Number(body.height) })
        send(200, "ok", { "content-type": "text/plain" })
      })
      return
    }
    // ---------- D 需求配商品（要看内容判断） ----------
    if (path === "/d/requests")
      return send(
        200,
        page(
          "采购需求",
          `<h1>采购需求（共 4 条）</h1><table><tr><th>编号</th><th>需求</th></tr>${needsOf(results.needsRound)
            .map((need) => `<tr><td>${need.id}</td><td>${need.text}</td></tr>`)
            .join("")}</table>`
        )
      )
    if (path === "/d/catalog")
      return send(
        200,
        page(
          "商品目录",
          `<h1>商品目录</h1><table><tr><th>编号</th><th>名称</th><th>说明</th></tr>${CATALOG.map((each) => `<tr><td>${each.code}</td><td>${each.name}</td><td>${each.note}</td></tr>`).join("")}</table>`
        )
      )
    if (path === "/d/order") {
      if (req.method === "POST") {
        void readForm(req).then((form) => {
          const need = form.get("need") ?? ""
          results.orderSubmits++
          results.orders.set(need, form.get("product") ?? "")
          send(303, "", { location: `/d/order?saved=${encodeURIComponent(need)}` })
        })
        return
      }
      const saved = url.searchParams.get("saved")
      const done = saved ? `<p role="status">已下单：${saved} → ${results.orders.get(saved) ?? ""}</p>` : ""
      return send(
        200,
        page(
          "下单",
          `<h1>下单</h1>${done}<form method="post" action="/d/order">
<label>需求编号 <select name="need"><option value="">请选择</option>${needsOf(results.needsRound)
            .map((need) => `<option value="${need.id}">${need.id}</option>`)
            .join("")}</select></label>
<label>商品 <select name="product"><option value="">请选择</option>${CATALOG.map((each) => `<option value="${each.code}">${each.code} ${each.name}</option>`).join("")}</select></label>
<button type="submit">提交</button>
</form>`
        )
      )
    }
    // ---------- E 前端翻页的列表（JSON 接口）+ 只认 token 的库存接口 ----------
    if (path === "/e/list") {
      results.eHits.list++
      return send(
        200,
        page(
          "商品列表 - 采购系统",
          `<h1>商品列表</h1><p id="pager">加载中…</p>
<table><thead><tr><th>编号</th><th>名称</th><th>单价（元）</th><th>供应商</th><th>库存</th></tr></thead><tbody id="rows"></tbody></table>
<p><button id="prev" type="button">上一页</button> <button id="next" type="button">下一页</button></p>
<p><a href="/e/report">提交汇总</a></p>
<script>
localStorage.setItem('stockToken', '${E_TOKEN}')
let current = 1
let pages = 1
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
async function load(n) {
  document.getElementById('pager').textContent = '加载中…'
  const res = await fetch('/e/api/items?page=' + n + '&size=${E_PAGE_SIZE}', { headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' } })
  const body = await res.json()
  if (body.code !== 0) { document.getElementById('pager').textContent = body.message || '加载失败'; return }
  current = body.data.page
  pages = Math.ceil(body.data.total / body.data.size)
  document.getElementById('rows').innerHTML = body.data.list.map((x) => '<tr><td>' + esc(x.code) + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.price) + '</td><td>' + esc(x.supplier) + '</td><td data-stock="' + esc(x.code) + '">…</td></tr>').join('')
  document.getElementById('pager').textContent = '第 ' + current + ' / ' + pages + ' 页，共 ' + body.data.total + ' 个'
  document.getElementById('prev').disabled = current <= 1
  document.getElementById('next').disabled = current >= pages
  const codes = body.data.list.map((x) => x.code).join(',')
  const stock = await fetch('/e/api/stock?codes=' + encodeURIComponent(codes), { headers: { authorization: 'Bearer ' + localStorage.getItem('stockToken'), accept: 'application/json' }, credentials: 'omit' }).then((r) => r.json())
  for (const each of stock.data || []) { const cell = document.querySelector('[data-stock="' + each.code + '"]'); if (cell) cell.textContent = each.stock }
}
document.getElementById('prev').onclick = () => load(current - 1)
document.getElementById('next').onclick = () => load(current + 1)
load(1)
</script>`
        ),
        { "set-cookie": `esid=${E_SESSION}; Path=/; HttpOnly; SameSite=Lax` }
      )
    }
    if (path === "/e/api/items") {
      const json = (status: number, body: unknown) => send(status, JSON.stringify(body), { "content-type": "application/json; charset=utf-8" })
      if (cookieOf(req, "esid") !== E_SESSION) {
        results.eHits.unauthorized++
        return json(401, { code: 401, message: "没有登录，请先打开商品列表页" })
      }
      results.eHits.items++
      const size = Math.min(50, Math.max(1, Number(url.searchParams.get("size")) || E_PAGE_SIZE))
      const n = Math.max(1, Number(url.searchParams.get("page")) || 1)
      const list = E_ITEMS.slice((n - 1) * size, n * size).map(({ code, name, price, supplier }) => ({ code, name, price, supplier }))
      // 像真的接口一样慢一点
      setTimeout(() => json(200, { code: 0, data: { list, page: n, size, total: E_ITEMS.length } }), 150)
      return
    }
    if (path === "/e/api/stock") {
      const json = (status: number, body: unknown) => send(status, JSON.stringify(body), { "content-type": "application/json; charset=utf-8" })
      if (req.headers.authorization !== `Bearer ${E_TOKEN}`) {
        results.eHits.unauthorized++
        return json(401, { code: 401, message: "token 无效" })
      }
      results.eHits.stock++
      const codes = (url.searchParams.get("codes") ?? "").split(",").filter(Boolean)
      return json(200, { code: 0, data: E_ITEMS.filter((each) => codes.includes(each.code)).map(({ code, stock }) => ({ code, stock })) })
    }
    if (path === "/e/report") {
      if (req.method === "POST") {
        void readForm(req).then((form) => {
          results.report = form.get("lines") ?? ""
          send(200, page("已提交", "<p>汇总已提交，谢谢。</p>"))
        })
        return
      }
      return send(
        200,
        page("提交汇总", `<h1>提交汇总</h1><form method="post" action="/e/report"><label>汇总（每行一个商品：名称,单价,供应商） <textarea name="lines" rows="8" cols="60"></textarea></label><button type="submit">提交</button></form>`)
      )
    }
    return send(200, page("基准站点", `<p>${HOST}</p>`))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    url: (path) => `http://${HOST}:${port}${path}`,
    results,
    reset() {
      results.products.clear()
      results.productSubmits = 0
      results.report = undefined
      results.pasted.clear()
      results.pasteCount = 0
      results.needsRound++
      results.orders.clear()
      results.orderSubmits = 0
      results.eHits = { list: 0, items: 0, stock: 0, unauthorized: 0 }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** 判分：做对了几项 / 一共几项 */
export function score(scenario: SpeedScenario, results: SpeedResults): { correct: number; total: number; notes: string[] } {
  const notes: string[] = []
  if (scenario === "D") {
    const needs = needsOf(results.needsRound)
    let correct = 0
    for (const need of needs) {
      const got = results.orders.get(need.id)
      if (got === need.want) correct++
      else notes.push(`${need.id}「${need.text}」：${got ? `选了 ${got}，应是 ${need.want}` : "没下单"}`)
    }
    if (results.orderSubmits > needs.length) notes.push(`提交了 ${results.orderSubmits} 次（多了 ${results.orderSubmits - needs.length} 次）`)
    return { correct, total: needs.length, notes }
  }
  if (scenario === "A") {
    let correct = 0
    for (const each of PRODUCTS) {
      const got = results.products.get(each.code)
      const ok =
        got &&
        got.name === each.name &&
        Number(got.price) === Number(each.price) &&
        Number(got.moq) === Number(each.moq) &&
        got.category === each.category &&
        Boolean(got.tax) === each.tax
      if (ok) correct++
      else notes.push(`${each.code}：${got ? JSON.stringify(got) : "没录"}`)
    }
    if (results.productSubmits > PRODUCTS.length) notes.push(`提交了 ${results.productSubmits} 次（多了 ${results.productSubmits - PRODUCTS.length} 次）`)
    return { correct, total: PRODUCTS.length, notes }
  }
  if (scenario === "E" || scenario === "F") {
    // 名称里的空格、全角半角括号不计较；F 还要有一栏正好是库存
    const norm = (text: string) => text.replace(/\s/g, "").replace(/，/g, ",").replace(/（/g, "(").replace(/）/g, ")")
    const lines = (results.report ?? "").split(/\r?\n/).map(norm)
    let correct = 0
    for (const code of E_TARGETS) {
      const each = E_ITEMS.find((item) => item.code === code)!
      const ok = lines.some(
        (line) =>
          line.includes(norm(each.name)) &&
          line.includes(each.price) &&
          line.includes(norm(each.supplier)) &&
          (scenario === "E" || line.split(",").includes(String(each.stock)))
      )
      if (ok) correct++
      else notes.push(`${each.name}：没有对的一行`)
    }
    if (results.report === undefined) notes.push("没提交汇总")
    return { correct, total: E_TARGETS.length, notes }
  }
  if (scenario === "B") {
    const lines = (results.report ?? "").split(/\r?\n/).map((line) => line.replace(/\s/g, "").replace(/，/g, ","))
    let correct = 0
    for (const id of TARGET_SUPPLIERS) {
      const each = SUPPLIERS.find((supplier) => supplier.id === id)!
      const ok = lines.some((line) => line.includes(each.name) && line.includes(each.phone) && line.includes(each.rating))
      if (ok) correct++
      else notes.push(`${each.name}：没有对的一行`)
    }
    if (results.report === undefined) notes.push("没提交汇总")
    return { correct, total: TARGET_SUPPLIERS.length, notes }
  }
  let correct = 0
  for (const letter of LETTERS) {
    const want = letterImages(letter).find((each) => each.correct)!
    const got = results.pasted.get(letter)
    if (got && got.width === want.width && got.height === want.height) correct++
    else notes.push(`${letter}：${got ? `贴的是 ${got.width}×${got.height}，应是 ${want.width}×${want.height}` : "没贴"}`)
  }
  if (results.pasteCount > LETTERS.length) notes.push(`粘贴了 ${results.pasteCount} 次（多了 ${results.pasteCount - LETTERS.length} 次）`)
  return { correct, total: LETTERS.length, notes }
}
