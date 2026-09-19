// 管道 stdin 全量读取：流注入（可测）；TTY stdin 直接返回空（管道才有 prompt 语义）。

export type StdinLike = NodeJS.ReadableStream & { readonly isTTY?: boolean };

export async function readPipedStdin(stdin: StdinLike = process.stdin): Promise<string> {
  if (stdin.isTTY === true) return "";
  return await new Promise<string>((resolveStream, rejectStream) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    stdin.on("end", () => {
      resolveStream(data);
    });
    stdin.on("error", (error: Error) => {
      rejectStream(error);
    });
  });
}
