import * as fs from "fs";
/** Validators and dependencies are bundled, but only initialized for explicit Schema use. */
export function schemaValidator(file: string): (text: string) => unknown {
  if (fs.statSync(file).size > 256 * 1024)
    throw new Error("Schema 文件超过 256 KiB。");
  const schema = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    typeof schema !== "boolean" &&
    (!schema || typeof schema !== "object" || Array.isArray(schema))
  )
    throw new Error("无效 JSON Schema。");
  const dialect = typeof schema === "object" ? schema.$schema || "" : "";
  const Ajv = /2020-12/.test(dialect)
    ? require("ajv/dist/2020").default
    : /2019-09/.test(dialect)
      ? require("ajv/dist/2019").default
      : require("ajv").default;
  const ajv = new Ajv({
    strict: false,
    strictSchema: true,
    validateFormats: true,
    allErrors: false,
  });
  require("ajv-formats").default(ajv);
  const validate = ajv.compile(schema);
  return (text) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("CLI 最终结果不是单个有效 JSON 文档；原始内容已保留。");
    }
    if (!validate(value))
      throw new Error("CLI 最终 JSON 不符合所选 Schema；原始内容已保留。");
    return value;
  };
}
