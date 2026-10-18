// 比物的初始数据：库里一个比对标准都没有时自动建的默认标准（像内置工具的说明一样由平台给出，人以后在页面上改）。
// 文字是通用的「是不是同一款」判断，不针对任何业务；演示数据（seed/compare-fixture.ts）也用这一份。

export const DEFAULT_STANDARD_ID = "std-same-item"
export const DEFAULT_STANDARD_NAME = "同款判断"
export const DEFAULT_STANDARD_PASS_SCORE = 95

export const SAME_ITEM_PROMPT = `判断两张图是不是同一款商品（可以不是同一张照片）。
- 形态和结构一致最重要：轮廓、比例、部件（把手、盖子、开口）一样才算同款；
- 颜色、材质、表面图案其次；
- 拍摄角度、背景、光线、水印不算差异。
每一项给 0～100 分，最后给总分和把握度；看不清、证据不够时总分写 null。`

/** 自己写要求、又没有默认标准可参照时的合格线 */
export const FALLBACK_PASS_SCORE = 90
