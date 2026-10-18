// 导入的上限和目录。数字大多来自 shared/imports.ts（前端也要显示），这里加上服务端才用的；测试可以用 configureImports 调小。
import { join } from "node:path"

import { IMPORT_MAX_FILES, IMPORT_MAX_MB, IMPORT_MAX_UNPACKED_MB } from "@heyagent/shared"

import { runtime } from "../engine/runtime.js"

const MB = 1024 * 1024

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export interface ImportLimits {
  /** 上传的 zip 最大多少字节（HEYAGENT_IMPORT_MAX_MB） */
  maxBytes: number
  /** 包里最多多少个文件 */
  maxFiles: number
  /** 解压后一共最多多少字节（按实际写出的字节算） */
  maxUnpackedBytes: number
  /** 单个文件超过这么大就不当文字读（日志、数据库导出之类，AI 也读不完） */
  maxTextFileBytes: number
  /** 读包（含翻译规则）最多花多少美元（HEYAGENT_IMPORT_MAX_COST_USD） */
  maxCostUsd: number
  /** 读包 agent 最多调多少次模型 */
  maxSteps: number
  /** read_file 一次最多给多少字、整个读包最多读多少字 */
  readChunkChars: number
  readTotalChars: number
  /** 交上来的方案不合格时最多让它改几次 */
  planFixes: number
  /** 单次读包最多跑多久（pg-boss 任务 60 分钟过期，这里留出收尾的时间） */
  maxRunMs: number
  /** 读包时同时翻译几条规则 */
  compileConcurrency: number
}

export const importLimits: ImportLimits = {
  maxBytes: num("HEYAGENT_IMPORT_MAX_MB", IMPORT_MAX_MB) * MB,
  maxFiles: IMPORT_MAX_FILES,
  maxUnpackedBytes: IMPORT_MAX_UNPACKED_MB * MB,
  maxTextFileBytes: 2 * MB,
  maxCostUsd: num("HEYAGENT_IMPORT_MAX_COST_USD", 5),
  maxSteps: 150,
  readChunkChars: 40_000,
  readTotalChars: 600_000,
  planFixes: 2,
  maxRunMs: 55 * 60_000,
  compileConcurrency: 3,
}

/**
 * 通用的依赖、缓存、构建产物目录：不解开、不给 AI 读，列文件时标「跳过」（任何框架的包都一样，不针对哪一种）
 */
export const SKIPPED_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__", "venv", ".venv", "site-packages", "dist", "build", ".cache", ".pytest_cache", ".mypy_cache", ".tox", ".next", ".turbo", "bower_components"])

/** 路径里有没有要跳过的目录 */
export const inSkippedDir = (path: string) => path.split("/").slice(0, -1).some((part) => SKIPPED_DIRS.has(part))

/** 测试用：改上限 */
export function configureImports(patch: Partial<ImportLimits>) {
  Object.assign(importLimits, patch)
}

/** 一次导入在文件目录下的工作目录：files/ 是解压出来的原文件，text/ 是挪走密钥后的文字（给 AI 读、做附件用） */
export const importDir = (id: string) => join(runtime.filesDir, "imports", id)
export const importFilesDir = (id: string) => join(importDir(id), "files")
export const importTextDir = (id: string) => join(importDir(id), "text")
/** 解压出来的文件清单（PackageFile[]），导入时按它找附件 */
export const importManifest = (id: string) => join(importDir(id), "manifest.json")

/** 给人看的大小 */
export function sizeText(bytes: number) {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} 字节`
}
