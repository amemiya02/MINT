type JsonObject = Readonly<Record<string, unknown>>;

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly annotations?: JsonObject;
}

interface McpRequest {
  readonly endpoint: string;
  readonly method: "POST" | "DELETE";
  readonly body?: JsonObject;
  readonly responseId?: number;
  readonly session?: string;
  readonly version?: string;
}

interface McpResponse {
  readonly body: string;
  readonly session?: string;
  readonly contentType?: string;
}

export type McpTransport = (request: McpRequest, signal?: AbortSignal) => Promise<McpResponse>;
export const mcpResponseLimit = 1024 * 1024;
export const mcpArgumentsLimit = 64 * 1024;

const supportedVersions = ["2025-11-25", "2025-06-18", "2025-03-26"];

export function mcpEndpoint(address: string): string {
  const url = new URL(address.trim());
  const loopback = /^(localhost|\[::1\]|127\.(\d+\.){2}\d+)$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw "invalidAddress";
  return url.href;
}

export function jsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sameJson(a: unknown, b: unknown): boolean {
  const ordered = (_key: string, value: unknown) =>
    jsonObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value;
  return JSON.stringify(a, ordered) === JSON.stringify(b, ordered);
}

export function mcpIsEventStream(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

function rpcResponse(payload: string, id: number): JsonObject | undefined {
  const message: unknown = JSON.parse(payload);
  if (jsonObject(message) && message.id === id && message.jsonrpc === "2.0") return message;
}

export function mcpEventResponse(event: string, id: number): JsonObject | undefined {
  const payload = event
    .split(/\r?\n/)
    .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).replace(/^ /, "")] : []))
    .join("\n");
  return payload ? rpcResponse(payload, id) : undefined;
}

function readRpc(response: McpResponse, id: number): JsonObject {
  const message = mcpIsEventStream(response.contentType)
    ? response.body
        .split(/\r?\n\r?\n/)
        .slice(0, -1)
        .map((event) => mcpEventResponse(event, id))
        .find((event) => event !== undefined)
    : rpcResponse(response.body, id);
  if (!jsonObject(message?.result)) throw "mcpFailed";
  return message.result;
}

async function withTools<T>(
  transport: McpTransport,
  endpoint: string,
  signal: AbortSignal | undefined,
  use: (
    tools: readonly McpTool[],
    request: (method: string, params: JsonObject) => Promise<JsonObject>,
  ) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  let id = 0;
  let session: string | undefined;
  let version: string | undefined;
  async function post(method: string, params?: JsonObject, responseId?: number) {
    signal?.throwIfAborted();
    return transport(
      {
        endpoint,
        method: "POST",
        body: { jsonrpc: "2.0", id: responseId, method, params },
        responseId,
        session,
        version,
      },
      signal,
    );
  }
  async function request(method: string, params: JsonObject) {
    const requestId = ++id;
    return readRpc(await post(method, params, requestId), requestId);
  }
  try {
    const initialize = ++id;
    const response = await post(
      "initialize",
      {
        protocolVersion: supportedVersions[0],
        capabilities: {},
        clientInfo: { name: "MINT", version: "0.4.0" },
      },
      initialize,
    );
    session = response.session;
    const result = readRpc(response, initialize);
    if (
      typeof result.protocolVersion !== "string" ||
      !supportedVersions.includes(result.protocolVersion) ||
      !jsonObject(result.capabilities) ||
      !jsonObject(result.capabilities.tools)
    )
      throw "mcpFailed";
    version = result.protocolVersion;
    await post("notifications/initialized");

    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result.tools) || tools.length + result.tools.length > 200)
        throw "mcpFailed";
      for (const tool of result.tools) {
        if (
          typeof tool?.name !== "string" ||
          !tool.name.trim() ||
          tool.name.length > 128 ||
          !jsonObject(tool.inputSchema) ||
          tool.inputSchema.type !== "object" ||
          tools.some(({ name }) => name === tool.name)
        )
          throw "mcpFailed";
        tools.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : undefined,
          inputSchema: tool.inputSchema,
          annotations: jsonObject(tool.annotations) ? tool.annotations : undefined,
        });
      }
      if (result.nextCursor === undefined || result.nextCursor === "")
        return await use(tools, request);
      if (typeof result.nextCursor !== "string" || result.nextCursor === cursor) throw "mcpFailed";
      cursor = result.nextCursor;
    }
    throw "mcpFailed";
  } finally {
    if (session) {
      // Disconnect best-effort. A lost reply or failed shutdown must never repeat a tool call.
      void transport({ endpoint, method: "DELETE", session, version }).catch(() => {});
    }
  }
}

export function listMcpTools(transport: McpTransport, endpoint: string, signal: AbortSignal) {
  return withTools(transport, endpoint, signal, async (tools) => tools);
}

export function callMcpTool(
  transport: McpTransport,
  endpoint: string,
  tool: McpTool,
  args: JsonObject,
  signal?: AbortSignal,
) {
  return withTools(transport, endpoint, signal, async (tools, request) => {
    if (
      !sameJson(
        tools.find(({ name }) => name === tool.name),
        tool,
      )
    )
      throw "mcpToolChanged";
    const result = await request("tools/call", { name: tool.name, arguments: args });
    // Return data only. The writing connection cannot turn further requests into external actions.
    return {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    };
  });
}
