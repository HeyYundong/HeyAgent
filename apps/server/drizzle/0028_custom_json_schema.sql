-- 自定义模型服务的开关「支持 json_schema」：打开后结构化输出按 JSON Schema 发给服务（vLLM、strata 等认）；默认关，格式写进提示词
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "supports_json_schema" boolean DEFAULT false NOT NULL;
