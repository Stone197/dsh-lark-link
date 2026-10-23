// In-process fake of @larksuiteoapi/node-sdk for the "real apply()" integration
// harness. The module is substituted by ./lark-sdk-hooks.mjs, so buildLarkClient
// (src/host/lark-client.ts) ends up wrapping THIS client: apply() keeps its
// normal code path while every Feishu network call is captured in-process.
//
// Captured state is exposed as globalThis.__DSH_FAKE_LARK__ so the TypeScript
// harness can assert on it without importing this .mjs file directly.

const registry = (globalThis.__DSH_FAKE_LARK__ ??= {
  clients: [],
  dispatchers: [],
  wsClients: [],
  /** One entry per im/v1/messages create (the sender's outward replies). */
  messages: [],
  /** One entry per messageReaction.create. */
  reactions: [],
  /** Every raw SDK `request()` (cardkit / bot info / generic). */
  requests: [],
  cardSeq: 0,
  msgSeq: 0,
  reset() {
    this.clients.length = 0;
    this.dispatchers.length = 0;
    this.wsClients.length = 0;
    this.messages.length = 0;
    this.reactions.length = 0;
    this.requests.length = 0;
    this.cardSeq = 0;
    this.msgSeq = 0;
  },
});

function recordMessage(args) {
  const data = args?.data ?? {};
  const params = args?.params ?? {};
  const entry = {
    receiveId: data.receive_id,
    receiveIdType: params.receive_id_type,
    msgType: data.msg_type,
    content: data.content,
    uuid: data.uuid,
  };
  registry.messages.push(entry);
  registry.msgSeq += 1;
  return { code: 0, message_id: `om_fake_sent_${registry.msgSeq}`, data: { message_id: `om_fake_sent_${registry.msgSeq}` } };
}

class FakeClient {
  constructor(opts) {
    this.opts = opts;
    registry.clients.push(this);
    this.im = {
      message: {
        create: async (args) => recordMessage(args),
        reply: async (args) => recordMessage(args),
        list: async () => ({ code: 0, data: { items: [] } }),
        messageResource: {},
      },
      messageReaction: {
        create: async (args) => {
          registry.reactions.push({
            message_id: args?.path?.message_id,
            emoji_type: args?.data?.reaction_type?.emoji_type,
          });
          return { code: 0 };
        },
      },
      file: {
        create: async () => ({ code: 0, file_key: "file_fake_1" }),
      },
      image: {
        create: async () => ({ code: 0, image_key: "image_fake_1" }),
      },
      messageResource: {
        get: async () => ({ getReadableStream: () => undefined }),
      },
    };
  }

  async request(opts) {
    const url = String(opts?.url ?? "");
    registry.requests.push({ url, method: opts?.method, data: opts?.data, params: opts?.params });
    if (url.includes("/open-apis/bot/v3/info")) {
      return { bot: { open_id: "ou_fake_bot", app_name: "fake-lark-bot" } };
    }
    if (/\/open-apis\/cardkit\/v1\/cards$/.test(url) && (opts?.method ?? "POST") === "POST") {
      registry.cardSeq += 1;
      return { data: { card_id: `fake_card_${registry.cardSeq}` } };
    }
    return { code: 0, data: {} };
  }
}

class FakeWSClient {
  constructor(opts) {
    this.opts = opts;
    this.started = false;
    registry.wsClients.push(this);
  }
  start(payload) {
    this.started = true;
    this.payload = payload;
  }
  stop() {
    this.started = false;
  }
}

class FakeEventDispatcher {
  constructor(opts) {
    this.opts = opts;
    this.handlers = {};
    registry.dispatchers.push(this);
  }
  register(map) {
    Object.assign(this.handlers, map ?? {});
    return this;
  }
}

const defaultHttpInstance = { defaults: { proxy: true } };

export class Client extends FakeClient {}
export class WSClient extends FakeWSClient {}
export class EventDispatcher extends FakeEventDispatcher {}
export const AppType = { SelfBuild: 0, ISV: 1, Personal: 2 };
export const Domain = { Feishu: 1, Lark: 2 };
export const LoggerLevel = { debug: 4, info: 3, warn: 2, error: 1, fatal: 0 };
export { defaultHttpInstance };
export default { Client, WSClient, EventDispatcher, AppType, Domain, LoggerLevel, defaultHttpInstance };
