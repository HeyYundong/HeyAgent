# v1 外部平台接入可行性调研

> 调研日期 2026-10-17。只查公开资料，没有登录或注册任何账号，也没有做自动化抓取。open.1688.com、developer.aliyun.com、amazon.com 帮助页在调研环境里打不开，相关内容来自搜索引擎摘要和二手文章，已在正文标注。标「未核实」的内容没有找到官方原文，或者各来源说法矛盾；标「经验判断」的是行业常识，没有找到可引用的来源。条款问题只点到为止，一律「需法务确认」。

## 结论：v1 建议

| 平台 / 环节 | 建议做法 | 难度 | 主要风险 | 放进 v1？ |
|---|---|---|---|---|
| Shopify 独立站商品页（解析客户链接） | 先调公开端点 `/products/{handle}.js`（官方 Ajax API），失败时读页面里的结构化数据，再不行就用浏览器截图 | 低 | 云服务器 IP 可能收到 429/430；少数店铺有额外防护 | **放**，作为第 1 步 |
| Shopify 全网同款（Catalog） | 官方 Global Catalog MCP（2026-06 起向所有开发者开放，支持以图搜） | 低～中 | 结果不允许缓存，和「存比价表」可能冲突（需法务确认）；只覆盖 Shopify 店铺 | 可选：v1 做个小试验 |
| 亚马逊美国站：前台搜索和商品页 | 浏览器，不登录，固定美国收货邮编，低频访问；遇到验证码就暂停、转人工 | 中 | 验证码、IP 封禁；条款禁止机器人（需法务确认） | **放** |
| 亚马逊：官方接口 | Creators API 要求近 30 天有 10 笔联盟成交，我们达不到；SP-API 需要专业卖家账号 | 高 | 门槛 | 不放 |
| 亚马逊：第三方数据（Rainforest / Keepa） | 按次付费的 API | 低 | 费用；数据来源合规性由服务商承担（需法务确认） | 可选：浏览器不稳定时作为备选 |
| Temu 美国站 | 浏览器 + 美国住宅代理，先切到美国站再搜；查不到就转人工 | 中～高 | 反爬很强（二手资料称是最难抓的电商之一）；是否必须登录未核实 | 放，但定位为「尽力而为」，失败直接转人工 |
| TikTok Shop 美国 | 没有买家侧 API；榜单可以用第三方工具（Kalodata / FastMoss），由人工查 | 高 | 条款明文禁止自动化抓取；价格要靠 JS 渲染，机房 IP 会被封（二手资料） | 不做自动化，v1 由人工处理 |
| 1688 关键词搜索和以图搜 | v1 用浏览器 + 人工登录的买家账号低频操作；**同时**申请开放平台跨境「自用」方案（含多语言图搜 `product.search.imageQuery`） | 中～高 | 账号风控和滑块验证；开放平台接口审批结果和费用未核实 | **放**（浏览器），并且马上启动接口申请 |
| 1688 区分工厂和贸易商 | 读搜索结果和店铺页上的「超级工厂 / 实力商家 / 源头工厂」标识 | 中 | 标识口径会变 | 放 |
| 1688 旺旺询价（长宽高、重量、报价） | 人工。开放平台没有找到聊天收发接口；官方文档对旺旺相关能力写明「不允许自动化批量操作」 | 高 | 违反平台规则、封号 | 不放（v1 由 agent 起草问题，人去发） |
| 1688 下单和打样付款 | 人工。官方有下单接口 `alibaba.trade.fastCreateOrder`，但涉及付款授权 | 高 | 资金安全 | 不放 |
| 物流运费估算 | 本次没有调研（不是外部平台问题） | — | — | 另议 |
| WhatsApp（AM 发消息） | v1 不接。现在就去做 Meta 商业验证，v2 用官方 Cloud API；**禁止**用个人号网页版自动化 | 中 | 个人号自动化会被封号 | 不放，但现在启动准备工作 |
| 以图搜的替代方案 | Shopify Catalog 以图搜、Google Cloud Vision Web Detection、SerpApi Google Lens 可以作为补充 | 低～中 | 都覆盖不到 1688 工厂货源 | 可选：小试验 |

**一句话**：v1 的主链路是「Shopify 公开端点解析链接 → 浏览器查亚马逊 / Temu → 浏览器在 1688 以图搜、筛工厂 → 生成比价表」，询价、下单、给客户发消息都留给人。同时启动三件慢事：1688 开放平台企业申请、Meta 商业验证、为 agent 准备专用的买家账号和代理。

---

## 1. Shopify 独立站商品页

**公开端点**
- `GET /{locale}/products/{handle}.js` 是 Shopify **官方文档里写明的** Ajax Product API，任何人都可以请求，返回商品 JSON（标题、价格、变体、图片），最多 250 个变体。价格用访客的展示币种，可以用 `/cart.js` 的 `currency` 字段确认。文档没有写限流。[S1]
- `/products.json`（全店商品列表，`limit=250` 分页）不在官方文档里，但被广泛使用。二手资料说有些大店会关掉它或者严格限流。[S2] 安全厂商的文章说店主「无法完全关闭这些端点，只能加防护」（IP 封禁、限流）。[S3]
- 单个商品的 `/products/{handle}.json` 和 `.oembed`：没有找到官方文档，**未核实**是否仍然可用。建议只把 `.js` 当作主路径。

**限制**：官方把 HTTP 430 定义为「请求被判为可能恶意」，和 429 限流不是一回事。[S4] 社区报告显示，从云服务器 IP 请求 `products.json` 时，即使频率很低也会收到 429，同样的请求从住宅 IP 发出就正常。[S5] 所以服务器端调用要走代理，并且频率要低。

**店铺关闭端点时的兜底**（按顺序）：
1. 用浏览器打开商品页，读 HTML 里的 `application/ld+json`（schema.org Product）和 `og:` meta 标签（经验判断：绝大多数主题都会输出）；
2. 用浏览器截图，再让多模态模型抽取信息；
3. 官方的 Storefront Catalog MCP：`https://{店铺域名}/api/ucp/mcp`，提供 `search_catalog`、`lookup_catalog`、`get_product` 三个工具，请求里必须带 agent profile URL。[S6] 旧版文档写的是 `/api/mcp`、无需鉴权，工具名是 `search_shop_catalog`；社区反馈它已经改名为 `search_catalog`，所以调用前要先 `tools/list`。[S7]

**顺带发现：Shopify Catalog（官方）**。2026-06-17 的 Spring '26 发布会宣布，agentic commerce 层不再需要审批，任何开发者在 Developer Dashboard 注册 agent profile 后即可使用；Catalog API「Image search returns visually similar products across Catalog」。[S8] Global Catalog 的端点是 `https://catalog.shopify.com/api/ucp/mcp`，会限流，无 key 访问不能提额；**条款要求不缓存图片和搜索结果**。[S9] 它可以用来在别的 Shopify 店里找同款、看售价，但「不缓存」和我们要存比价表有冲突，需法务确认。

**v1 建议**：放进 v1。`.js` 端点 + JSON-LD 兜底 + 浏览器截图兜底，对应原型里的工具 `shopify.product`。条款风险低：`.js` 是官方公开接口，但还是要控制频率。

## 2. 亚马逊（美国站）

**前台（买家视角）**：搜索和商品页不需要登录就能看；价格和配送信息取决于收货邮编，所以要固定一个美国邮编；访问频率高了会出现验证码（以上均为经验判断）。截至 2026 年初，Amazon 的 robots.txt 屏蔽了将近 50 个 AI 相关的 user agent。[S10] Amazon 起诉了 Perplexity 的 Comet 购物 agent：2026 年 3 月一审下了初步禁令，[S11] 2026-08-04 第九巡回法院撤销了禁令，认为是用户本人在访问 Amazon，Perplexity 的行为不构成 CFAA 意义上的「访问」；Amazon 表示在评估下一步。[S12] 这说明法律边界还在变，而且该案只涉及 CFAA，不涉及合同条款。Amazon 的 Conditions of Use 原文在调研环境里打不开（503），里面关于 robots 和数据抓取的具体措辞**未核实**，需法务确认。

**Product Advertising API → Creators API**：PA-API 5 已经废弃，旧接口现在返回 403 `AccessDeniedException`；继任者是 Creators API。[S13] 废弃日期各来源说法不一（4/30、5/15），**未核实**哪个是准的。[S14] Creators API 的前提条件是：加入目标站点的 Associates 联盟计划，**近 30 天至少 10 笔合格成交**，在 Associates Central 注册。可用操作有 SearchItems、GetItems、GetVariations、GetBrowseNodes。[S15] 我们不做联盟推广，**拿不到**。

**SP-API**：私有开发者只能接入自己公司的数据，私有卖家应用需要**专业卖家账号**（个人卖家账号不行）。[S16] 曾宣布从 2026 年起对第三方开发者收 1400 美元年费，二手资料说 2026-05 已取消，[S17] Amazon 官网上**未核实**。理论上，有专业卖家账号后可以用 Catalog 和 Pricing 接口查任意 ASIN，但把这些数据用于给客户找货是否符合 Acceptable Use Policy，**未核实**，需法务确认。

**第三方数据服务**：
- Rainforest API（Traject Data）：$15/月 500 次 → $59/月 1 万次 → $375/月 25 万次，免费试用 100 次。[S18]
- Keepa API：按「每分钟 token 数」包月预付，查 1 个 ASIN 花 1 token，查报价每页另加 6 token，没用掉的 token 60 分钟后作废。[S19] 入门价二手资料写 €49/月（20 token/分钟），[S20] 官网价格页没打开，**未核实**。Keepa 的强项是历史价格曲线。
- 评估：v1 每天几十到几百次查询的量级，Rainforest 入门档就够用，可以作为浏览器被封时的备用通道。

**v1 建议**：用浏览器（不登录、美国邮编、低频、遇到验证码挂起转人工），对应原型里的「亚马逊验证码 → 挂起」流程。准备好 Rainforest 作为备选。官方 API 不做。

## 3. Temu（美国站）

- **对外 API**：只有卖家侧的开放平台。卖家在 Seller Center 创建自研应用，拿到 App Key 和 Secret，授权给自己的店铺使用；文档在 partner.temu.com。[S21] **没有找到**买家侧的商品搜索 API（二手资料，未核实官方表态）。
- **前台是否要登录**：**未核实**。只找到有人在第三方爬虫的 issue 里问「Temu 是不是开始要求登录才能搜索了」，没有明确答复。[S22]
- **站点和地区**：Temu 按地区分路径（`temu.com/{地区}`），美国站通常用根域名。[S23] 价格会随地区变化。[S24] 原型里的记忆 m-008「先切换到美国站」和这些资料一致，具体的判断依据（IP、地区选择器还是 cookie）**未核实**。建议：浏览器走美国出口 IP，进站后显式确认地区和币种是 US/USD，再开始搜。
- **风控**：二手资料（都来自卖爬虫工具的厂商）称 Temu 有 Cloudflare 类的浏览器完整性校验，纯 HTTP 请求会被 403 或拿到残缺数据，需要住宅代理和真实指纹，是最难抓的电商之一。[S25]
- **条款**：Temu Terms of Use 原文没取到，**需法务确认**。

**v1 建议**：放进 v1，但只作为「参考售价」来源，按「尽力而为」处理：每个账号并发数设为 1（和 `design/specs/browsers.md` 里的例子一致），失败就挂起转人工，不要为了 Temu 去追求绕过风控。

## 4. TikTok Shop（美国）

- **买家侧公开 API**：没有。Research API 只给学术和非营利机构，官方 FAQ 写明商业用户没有资格。[S26]
- **Partner / Affiliate API**：要在 TikTok Shop Partner Center 注册应用、走 OAuth。Affiliate API 能「按类目、佣金率、关键词查找开放带货合作的商品」，也能搜达人。[S27] 但它服务的是卖家和达人的业务，需要卖家或达人授权；我们不是这两种身份，**不适用**。
- **不登录能否访问新品榜、类目榜**：没有找到官方的公开榜单页，**未核实**。二手资料称：桌面端基本只能看分享出来的单个商品链接；[S28] 价格在静态 HTML 里是占位符，要等 JS 渲染后才显示；机房 IP 会被封；搜索、店铺、类目页挑战更重。[S29]
- **条款**：美国版服务条款（2026-07-15 更新，签约方已经变成「TikTok USDS Joint Venture」）明文禁止用任何自动化系统抓取或导出数据，除非得到书面许可。[S30]
- **替代方案**：第三方数据工具。Kalodata 约 $49.99～129.99/月，FastMoss 约 $46～139/月；价格来自二手资料，各来源说法不一。[S31]

**v1 建议**：不做自动化。搜品岗用 Kalodata 或 FastMoss 账号人工查，agent 只接收人工贴进来的链接或截图并整理。是否采购这类工具由老板决定。

## 5. 1688

**开放平台现在对买方开放的能力**（open.1688.com 打不开，以下来自搜索引擎对官方页面的摘要）：
- **跨境综合解决方案（自用）**，solutionKey=1697014160788：版本记录里列有「多语言商详」「多语言图搜 `product.search.imageQuery`」「多语言关键词搜索 `product.search.keywordQuery`」，详情接口是 `com.alibaba.fenxiao.crossborder:product.search.queryProductDetail`。[S32] 另有「图搜跨境商品」接口 `com.alibaba.linkplus:alibaba.cross.similar.offer.search`，可以按图片链接搜相似商品，并按价格、销量排序。[S32]
- **跨境代采解决方案**（4.3 版，2025-02-24 更新）：适用角色是跨境代采商，流程包括关键词翻译 → 调 1688 搜索 → 翻译展示信息，也支持按商品 URL 寻源、为已成交订单找更便宜的货源。[S33]
- **图搜代发**（`alibaba.public.image.similar.offer.search`）：面向在服务市场上架工具的分销服务商，不适合自用。[S34]
- **下单**：`alibaba.trade.fastCreateOrder`（普通采购下单），代发模式用 `alibaba.trade.fenxiaoOrder.create`。[S35]
- **询价单（RFQ）**：大企业采购方案里有询价单相关接口和消息（`caigou.api.buyOffer.*`，消息 `CAIGOU_MSG_BUYER_PUBLISH_BUYOFFER`，以及「供应商发布报价」）。[S36] 这是「请工厂报价」的**正规接口路径**，但它属于大企业采购 / 服务商方案，我们能不能申请**未核实**。
- **申请门槛**：二手资料一致说需要**企业实名认证**（营业执照、法人身份证、对公账户），自用型应用要单独申请图搜权限，人工审核 1～3 个工作日。[S37] 跨境 ERP 方案的官方页面也写着「提交资质申请，审核 1–3 个工作日」。[S33] 费用：二手资料说自研应用一般不收保证金，高级接口按年收资源包费用，[S38] **未核实**。网上常见的 `item_search_img`、`1688.item_get` 等名字是第三方 API 转售商自己起的，不是官方接口名，不要被误导。

**跨境专门计划**：
- 1688 Overseas 于 2025-03 上线，面向东南亚、中亚等地的海外买家，物流由菜鸟负责。[S39] 它是给海外买家用的前台，不是给我们的接口。
- 2026-07-17 世界人工智能大会上，1688 宣布联合电子标准院和蚂蚁推出 **UTP 通用交易协议**，把交易拆成寻源、询盘、订购、支付、履约、争议六个标准动作，并称「1688 上已有 20% 的采购需求由 AI Agent 发起」。[S40] **是否已经上线、有没有开发者文档：未核实**（没有搜到规范或接入入口）。
- 2026-10-13，1688 全面接入阿里的 AI 工作台 Accio，采购助手可以找供应商、比价、发询盘，买家可以直接开通；报道没有提到 API。[S41] 这是**最值得跟进的变化**：如果 UTP 或 Accio 开放 agent 接入，询盘环节可能有正规通道。

**浏览器以图搜同款**：官方对拍立淘的定位是「先申请白名单才能调用」。[S42] 网页版以图搜是否必须登录、滑块验证触发多频繁，**未核实**（经验判断：上传图片搜索通常需要登录，频率高了会出滑块验证）。区分工厂和贸易商可以看「诚信通 → 实力商家 → 超级工厂」这几档标识和「源头工厂」认证。[S43] 浏览器方案可行，但必须用专门的买家账号、固定 IP、低频操作、遇到验证码人工处理。

**旺旺 / 千牛消息**：没有找到面向买家的聊天收发接口。开放平台里和旺旺相关的接口（openUid 解密成旺旺昵称）文档写明「仅可使用于用户需要唤起旺旺，不允许自动化批量操作」。[S44] 官方采购助手插件只做消息提醒。[S45] 用浏览器网页版旺旺自动收发技术上也许可行，但明显违反上面的规则，封号风险高。

**v1 建议**：以图搜、关键词搜、筛工厂用浏览器（人工登录专用账号）；**马上**以公司名义申请开放平台「跨境综合解决方案（自用）」，拿到图搜和详情接口后替换浏览器。询价：agent 生成标准问题清单（长宽高、重量、MOQ、打样价），由采购岗在旺旺里人工发送，再把回复贴回系统。下单和付款完全人工。

## 6. WhatsApp Business Platform（Cloud API）

- **接入流程**：在 Meta 开发者后台创建应用（选 Connect with customers through WhatsApp）→ 关联 business portfolio 和 WhatsApp Business 账号 → 先用测试号联调 → 用系统用户生成永久 token → 配置 webhook。[S46] 正式号码必须是自己拥有的、能收短信或语音的号码；**已经在 WhatsApp App 上用的号码要先删掉**才能注册（另有 Business App「共存」模式可以保留原号，但只有二手资料，**未核实**）。[S47][S48] 新 portfolio 最多注册 2 个号码，完成商业验证或消息上限达到 2000 后提到 20 个。[S47]
- **消息上限**：新 portfolio 每 24 小时最多主动联系 250 个不同用户（客服窗口外）；完成商业验证、经 Meta 审核消息质量后提到 2000，之后按质量自动升档。[S49]
- **收费**：**2025-07-01 起从按对话收费改为按消息收费**，只对送达的模板消息收费，按类别（营销 / 工具 / 认证）、阶梯量和收件人国家定价；服务类对话从 2024-11-01 起免费。[S50] 北美的工具类消息从 2026-01-01 起降价，二手资料说从 $0.004 降到 $0.0034/条；[S51] 北美营销类单价**未核实**（官方费率表是交互页面，没取到数字）。
- **24 小时窗口**：用户发来消息后开启 24 小时客服窗口，窗口内可以发任意非模板消息，免费；窗口外只能发审核过的模板，按条计费。用户通过 Click-to-WhatsApp 广告进来时，有 72 小时全免费窗口。[S50] 收消息走 webhook。[S46]
- **AI 相关政策**：2026-01-15 起，Business Solution Terms 禁止「以通用 AI 助手为主要产品」的服务使用该平台；企业用 AI 做客服不受影响。[S52] 2026-02-16 起，对「AI Providers」另有定价政策。[S50] 我们是 B2B 业务沟通，应该不受影响，但 Meta 保留解释权，需法务确认。
- **个人号网页版自动化**：WhatsApp 帮助中心有专门的「未授权的自动化或批量消息」说明（正文没取到）。二手资料称 whatsapp-web.js 一类库都属于逆向，用在个人号上违反服务条款、可能被封；新号码最容易出问题。[S53] AM 的号码是和客户沟通的核心资产，**不能拿来冒险**。

**v1 建议**：v1 不接。现在就去做 Meta 商业验证，并确定用哪个号码（新号，还是共存模式保留 AM 现有号码）。v2 用 Cloud API，配合原型里的规则「给客户发消息前由 AM 确认」。

## 7. 以图搜同款的替代方案

| 方案 | 一句话评估 |
|---|---|
| 1688 开放平台多语言图搜 `product.search.imageQuery` | 首选，但需要企业申请，见 §5 |
| 淘宝开放平台拍立淘接口 | 网上的接口名五花八门，没找到官方文档，**未核实**；而且淘宝不是找工厂的主战场 |
| 阿里云图像搜索 ImageSearch（商品图片搜索）| 是「在你自己建的图库里搜」，不能搜淘宝或 1688 的商品库；[S54] 只能用来给公司历史货源去重 |
| Google Lens | **没有官方 API**（Google 社区工作人员回复）；[S55] 官方能用的是 Cloud Vision 的 Web Detection（找网上相似图片和页面），仍在文档中，没有被列为废弃；[S56] |
| SerpApi Google Lens API | 第三方抓取 Lens 的结果，返回 `visual_matches`，可以指定国家；[S57] 套餐 $25/月 1000 次起（二手）；[S58] 适合找海外零售同款，找不到 1688 工厂 |
| Shopify Catalog 以图搜 | 官方、免审批，只覆盖 Shopify 店铺，见 §1 |
| 自部署（CLIP / DINOv2 向量 + 向量库） | 只能搜自己的图库，没有平台商品数据，v1 不需要 |
| 第三方 1688 图搜转售 API | 「零资质」宣传多，数据来源合规性和稳定性都存疑，不建议 |

---

## 需要老板拍板或去落实的事

1. **以公司主体申请 1688 开放平台**：企业实名认证，申请「跨境综合解决方案（自用）」的图搜和详情权限，再顺便问清询价单（RFQ）接口能不能给我们用、费用多少。负责人：___。预计审核 1～3 个工作日，实际时间未核实。
2. **跟进 1688 UTP 协议和 Accio**：派人确认 UTP 是否上线、是否有 agent 接入入口；这是询盘环节唯一可能出现正规接口的方向。
3. **为 agent 准备专用的买家账号**：1688 买家账号（建议企业实名）、亚马逊和 Temu 是否需要账号（v1 先尝试不登录）。不要用员工的个人账号，避免封号连带。
4. **代理和 IP**：亚马逊、Temu、Shopify 需要美国出口 IP（住宅或 ISP 代理），1688 用国内固定 IP。要定预算和供应商。
5. **Meta 商业验证 + 号码方案**：新号还是共存模式；谁当 business portfolio 管理员。
6. **要不要买第三方数据**：Rainforest（亚马逊备选，$15～59/月起步）、Kalodata 或 FastMoss（TikTok Shop，约 $50～130/月）。
7. **法务确认**：Amazon、Temu、TikTok、1688 条款中关于自动化访问的条款；Shopify Catalog 的「不缓存」要求和比价表留存是否冲突；WhatsApp AI 政策的适用范围。
8. **v1 边界确认**：询价、下单付款、给客户发消息全部由人工完成，agent 只负责起草和整理。

## 参考链接（访问日期均为 2026-10-17）

- [S1] Shopify Ajax Product API：https://shopify.dev/docs/api/ajax/reference/product
- [S2] dev.to「Shopify's open secret: every store exposes products.json」：https://dev.to/shan_yun_ab0c7ad30b46ad2d/shopifys-open-secret-every-store-exposes-productsjson-30ni
- [S3] SecureCommerce 防抓取指南：https://www.securecommerce.io/guides/prevent-product-scraping/
- [S4] Shopify 响应码说明：https://www.shopify.dev/api/usage/response-codes
- [S5] Shopify 社区，签名爬虫从 OCI 访问被 429：https://community.shopify.dev/t/signed-web-bot-auth-crawler-gets-429-on-every-request-from-oci-since-2026-09-29/38441
- [S6] Shopify Storefront Catalog MCP：https://shopify.dev/docs/agents/catalog/storefront-mcp
- [S7] Shopify 社区，search_shop_catalog 改名：https://community.shopify.dev/t/storefront-mcp-search-shop-catalog-returning-tool-not-found-renamed-to-search-catalog/33256 ；旧文档：https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront
- [S8] Shopify Spring '26 开发者版（2026-06-17）：https://www.shopify.com/news/spring-26-edition-dev
- [S9] Shopify Catalog 文档：https://shopify.dev/docs/agents/catalog
- [S10] Tinuiti「Amazon agentic commerce」：https://tinuiti.com/blog/amazon/amazon-agentic-commerce/
- [S11] GeekWire，法官禁止 Perplexity 购物 agent（2026-03）：https://www.geekwire.com/2026/03/10/judge-blocks-perplexitys-ai-bot-from-shopping-on-amazon-in-early-test-of-agentic-commerce/
- [S12] MediaPost，第九巡回法院撤销禁令（2026-08-04）：https://www.mediapost.com/publications/article/417007/appeals-court-sides-against-amazon-lifts-perplexi.html
- [S13] Amazon Creators API，PA-API 5 废弃说明：https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation
- [S14] GitHub openlibrary issue #12255：https://github.com/internetarchive/openlibrary/issues/12255 ；dev.to 迁移文章：https://dev.to/th3nate/amazon-pa-api-v5-is-shutting-down-april-30-2026-here-is-what-changes-at-the-auth-layer-22ek
- [S15] Creators API 简介：https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction
- [S16] SP-API 注册概览：https://developer-docs.amazon/sp-api/docs/sp-api-registration-overview
- [S17] SP-API 收费公告：https://developer.amazonservices.com/spp-announcement ；取消报道：https://ppc.land/amazon-drops-sp-api-fees-after-developer-pushback
- [S18] Rainforest API 价格（Traject Data）：https://trajectdata.com/?p=1705
- [S19] Keepa API 套餐与 token 说明：https://keepa.com/api-docs/plans-tokens.html
- [S20] RevenueGeeks Keepa API 价格：https://revenuegeeks.com/software/keepa/api
- [S21] Temu 授权说明（第三方）：https://help.useresponse.com/hemi/knowledge-base/article/marketplaces-temu-technical-scope-temu-authorization ；https://unified.to/integrations/temu.md
- [S22] Apify Temu Scraper issue：https://beta-securitybyobscurity.apify.com/mscraper/temu-scraper/issues/no-results-3r1LAZWEYcHI3gjgw
- [S23] Apify Temu Scraper 说明：https://apify.com/lentic_clockss/temu-scraper
- [S24] ForestVPN Temu 文章：https://forestvpn.com/en/blog/e-commerce/temu-rising-star-global-online-shopping/
- [S25] Thunderbit「Best Temu scrapers 2026」：https://thunderbit.com/de/blog/best-temu-scrapers ；Decodo：https://decodo.com/scraping/web/temu-scraper-api
- [S26] TikTok Research API FAQ：https://developers.tiktok.com/doc/research-api-faq
- [S27] TikTok Shop Affiliate API 发布：https://developers.tiktok.com/blog/2024-tiktok-shop-affiliate-apis-launch-developer-opportunity
- [S28] TikTok Shop 桌面端说明（低质量来源）：https://atl-app-02.novadine.com/?p=28440
- [S29] Apify TikTok Shop Scraper：https://apify.com/khadinakbar/tiktok-shop-scraper
- [S30] TikTok 美国服务条款（2026-07-15 更新）：https://www.tiktok.com/legal/page/us/terms-of-service/en
- [S31] Hubfluence Kalodata vs FastMoss：https://www.hubfluence.io/blog/kalodata-vs-fastmoss ；Creatify：https://creatify.ai/blog/kalodata-pricing-plans-and-what-you-ll-actually-pay-in-2026 ；Delzonic：https://delzonic.com/blogs/fastmoss-pricing-2026/
- [S32] 1688 跨境综合解决方案（自用）：https://open.1688.com/solution/solutionDetail.htm?solutionKey=1697014160788 ；图搜跨境商品：https://open.1688.com/api/apidocdetail.htm?aopApiCategory=linkplus&id=com.alibaba.linkplus%3Aalibaba.cross.similar.offer.search-1 ；多语言商详：https://open.1688.com/api/apidocdetail.htm?id=com.alibaba.fenxiao.crossborder%3Aproduct.search.queryProductDetail-1
- [S33] 1688 跨境代采解决方案：https://open.1688.com/solution/detail?key=1675408994871 ；跨境 ERP/独立站 SaaS 方案：https://open.1688.com/solution/solutionDetail.htm?solutionKey=1697015308755
- [S34] 1688 分销工具 / 图搜代发方案：https://open.1688.com/solution/solutionDetail.htm?solutionKey=1661394658769 ；接口：https://open.1688.com/api/apidocdetail.htm?id=com.alibaba.product%3Aalibaba.public.image.similar.offer.search-1
- [S35] 1688 ERP 分销解决方案：https://open.1688.com/solution/solutionDetail.htm?solutionKey=1631677697552
- [S36] 1688 询价单接口：https://open.1688.com/api/apidocdetail.htm?aopApiCategory=purchase_integrate&id=cn.alibaba.open%3Acaigou.api.buyOffer.getBuyOfferById-1 ；询价消息：https://open.1688.com/message/topicDetail.htm?id=CAIGOU_MSG_BUYER_PUBLISH_BUYOFFER&topicGroup=CAIGOU
- [S37] 阿里云开发者社区，拍立淘白名单申请（第三方）：https://developer.aliyun.com/article/1743419 ；OSCHINA：https://my.oschina.net/u/9757405/blog/19710541
- [S38] 掘金，1688 官方 API 入驻指南（第三方）：https://juejin.cn/post/7549888200229077027
- [S39] KrASIA「Where does 1688 fit」：https://amp.kr-asia.com/where-does-1688-fit-into-alibabas-e-commerce-game-plan
- [S40] 网易，1688 推出 UTP（2026-07）：https://www.163.com/dy/article/L2293S0405118HA4.html ；新浪财经：https://finance.sina.com.cn/stock/t/2026-07-17/doc-iniiccuw7401833.shtml
- [S41] 新浪科技，1688 全面接入 Accio（2026-10-13）：https://finance.sina.com.cn/tech/roll/2026-10-13/doc-iniuzzhf5031424.shtml
- [S42] 阿里云开发者社区，拍立淘接口申请（第三方）：https://developer.aliyun.com/article/1740521
- [S43] 1688 wiki，源头工厂：https://www.1688.com/wiki/zh/WKfh0c3y22nh1c ；Supplyia：https://www.supplyia.com/how-to-identify-a-legit-supplier-on-1688/
- [S44] 1688 旺旺昵称解密接口：https://open.1688.com/api/apidocdetail.htm?id=com.alibaba.account%3Awangwangnick.openuid.decrypt-1
- [S45] 1688 采购助手插件：https://chrome.google.com/webstore/detail/1688%E9%87%87%E8%B4%AD%E5%8A%A9%E6%89%8B%E6%8F%92%E4%BB%B6%E7%89%88/kphldkppgfpjadpabfkghmjbhpcmgpdg
- [S46] WhatsApp Cloud API 入门：https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- [S47] WhatsApp 商业电话号码：https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers
- [S48] Telnyx 共存模式说明（第三方）：https://developers.telnyx.com/docs/messaging/whatsapp/coexistence.md
- [S49] WhatsApp 消息上限：https://developers.facebook.com/docs/whatsapp/messaging-limits
- [S50] WhatsApp 定价：https://developers.facebook.com/docs/whatsapp/pricing
- [S51] Gupshup 2026-01 更新日志：https://partner-docs.gupshup.io/changelog/january-2026
- [S52] TechCrunch，WhatsApp 禁止通用聊天机器人：https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/
- [S53] WhatsApp 帮助中心「未授权的自动化或批量消息」：https://faq.whatsapp.com/5957850900902049 ；开源库风险汇总：https://whatsapp.checkleaked.cc/blog/best-open-source-whatsapp-libraries
- [S54] 阿里云图像搜索开通说明：https://help.aliyun.com/zh/viapi/developer-reference/visual-search-is-introduced
- [S55] Google 开发者社区，Lens 与 Vision API 的区别：https://discuss.google.dev/t/difference-google-lens-vs-google-cloud-vision-api/193387
- [S56] Cloud Vision 废弃功能列表（2026-10-13 更新）：https://docs.cloud.google.com/vision/docs/deprecations ；Web Detection：https://docs.cloud.google.com/vision/product-search/docs/samples/vision-web-detection-tutorial
- [S57] SerpApi Google Lens API：https://serpapi.com/google-lens-api
- [S58] SerpApi 价格：https://serpapi.com/pricing.md
