import { fileURLToPath } from "node:url";
import { sdkPublicEntries } from "../../sdk/src/index";

export const sdkDirectories = Object.freeze([
  ...new Set([
    ...sdkPublicEntries.map((entry) =>
      fileURLToPath(new URL("../../" + entry.source.split("/src/")[0] + "/src", import.meta.url)),
    ),
    fileURLToPath(new URL("../../sdk/src", import.meta.url)),
  ]),
]);
