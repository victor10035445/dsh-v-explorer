/**
 * reader-json.jsx — JSON 渲染器（官方 documentPreviews 的 extension 实现）。
 *
 * 设计（proposal）：≥2MB 或 eof 未达不美化，按原文展示；美化仅在 eof（完整
 * 文本才有解析意义）且 ≤2MB 时进行；解析失败原样展示（JSON5/容错内容不猜格式）。
 * wrap:true 消费官方 wrap 偏好（pre ↔ pre-wrap 切换）。
 */
import { useMemo } from "react";
// 纯逻辑/元数据在 reader-shared.mjs（node 可直接测）；这里 re-export 保持旧入口。
import { READER_JSON_ID, PRETTIFY_CHAR_LIMIT, prettifyDecision, readerJsonDefinition } from "./reader-shared.mjs";

export { READER_JSON_ID, PRETTIFY_CHAR_LIMIT, prettifyDecision, readerJsonDefinition };

export function ReaderJsonBody({ content, wrap, scrollportRef }) {
  const isText = content?.kind === "text";
  const decision = useMemo(
    () => (isText ? prettifyDecision(content.text, content.eof) : { text: "", pretty: false }),
    [isText, isText ? content.text : "", isText ? content.eof : false]
  );
  if (!isText) return null;
  return (
    <div className="dve-rp">
      <div
        className="dve-rpBody"
        ref={(el) => {
          scrollportRef?.(el);
        }}
      >
        <pre className={"dve-json" + (wrap ? " dve-jsonWrap" : "")} data-dve-reader="json">
          {decision.text}
        </pre>
      </div>
    </div>
  );
}
