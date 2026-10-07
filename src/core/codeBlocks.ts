export function codeBlocks(content: string): string[] {
  return Array.from(
    content.matchAll(/```[^\n]*\n([\s\S]*?)```/g),
    (match) => match[1],
  );
}

/** Keep original fence indices stable for source verification. Diagrams have no edit actions. */
export function actionableCodeBlocks(
  content: string,
): Array<{ code: string; blockIndex: number; filePath?: string }> {
  return Array.from(content.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)).flatMap(
    (match, blockIndex) =>
      /^(mermaid|plantuml|graphviz|dot|text|plaintext|markdown|md)(?:\s|$)/i.test(
        match[1].trim(),
      )
        ? []
        : [
            {
              code: match[2],
              blockIndex,
              filePath: match[1]
                .match(/(?:^|\s)(?:file|path)=(?:"([^"\r\n]+)"|([^\s]+))/)
                ?.slice(1)
                .find(Boolean),
            },
          ],
  );
}
