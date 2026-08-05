import { McpServer } from "@modelcontextprotocol/server";

import type { UploadPreparer } from "./uploads.js";

export const uploadDocumentationUri = "agentslicer://docs/upload";

function uploadDocumentation(uploads: UploadPreparer): string {
  return `# Uploading models to AgentSlicer

AgentSlicer imports STL, OBJ, 3MF, STEP, and STP files from \`/workspace\`. Local client files must be
uploaded before calling \`model_import\`.

## Workflow

1. Compute the file byte length and lowercase SHA-256 digest.
2. Call \`upload_prepare\` with \`filename\`, \`bytes\`, and \`sha256\`.
3. Resolve the returned \`upload_path\`, which is beneath \`/uploads\`, against the MCP
   endpoint origin.
4. Send one authenticated HTTP \`PUT\` containing the raw file bytes. Use the same bearer
   token as MCP, \`Content-Type: application/octet-stream\`, and the exact returned
   \`Content-Length\`.
5. Call \`model_import\` with the returned \`workspace_path\` after the PUT succeeds.

Upload tickets are single-use and expire after ${uploads.ttlMs} milliseconds. A failed PUT
requires a new \`upload_prepare\` call. The maximum upload size is ${uploads.maxBytes} bytes.
The server verifies the exact byte count and SHA-256 before atomically publishing the file.
Partial or mismatched uploads are not importable.
`;
}

export function registerAgentResources(server: McpServer, uploads: UploadPreparer): void {
  server.registerResource(
    "upload-guide",
    uploadDocumentationUri,
    {
      title: "Uploading models",
      description: "Authenticated upload workflow for STL, OBJ, 3MF, STEP, and STP model files.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: uploadDocumentation(uploads),
        },
      ],
    }),
  );
}
