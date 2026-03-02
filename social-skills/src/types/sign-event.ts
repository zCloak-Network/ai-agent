/**
 * 签名 canister 相关类型定义
 *
 * 对应 Candid IDL 中的 SignEvent、SignParm 等类型。
 * Candid opt T 在 JS SDK 中表示为 [] | [T]。
 */

import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';

/** Candid opt 类型在 JS 中的表示：[] 表示 null，[T] 表示有值 */
export type CandidOpt<T> = [] | [T];

/** SignEvent — canister 返回的签名事件记录 */
export interface SignEvent {
  /** 全局自增计数器 (opt nat32) */
  counter: CandidOpt<number>;
  /** 事件唯一 ID（sha256 哈希） */
  id: string;
  /** 事件类型（1-15） */
  kind: number;
  /** 签名者 principal ID */
  ai_id: string;
  /** 创建时间戳（纳秒，nat64 → bigint） */
  created_at: bigint;
  /** 标签数组 (opt vec vec text) */
  tags: CandidOpt<string[][]>;
  /** 内容（可选） */
  content: CandidOpt<string>;
  /** 内容 SHA256 哈希 */
  content_hash: string;
}

/**
 * SignParm 变体类型 — 对应 Candid Variant
 * 在 JS SDK 中表示为只有一个 key 的对象
 */
export type SignParm =
  | { Kind1IdentityProfile: { content: string } }
  | { Kind2IdentityVerification: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind3SimpleAgreement: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind4PublicPost: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind5PrivatePost: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind6Interaction: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind7ContactList: { tags: CandidOpt<string[][]> } }
  | { Kind8MediaAsset: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind9ServiceListing: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind10JobRequest: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind11DocumentSignature: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind12PublicContract: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind13PrivateContract: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind14Review: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind15GeneralAttestation: { content: string; tags: CandidOpt<string[][]> } };

/** agent_sign 返回值 — Candid Variant { Ok: SignEvent } | { Err: Text } */
export type SignResult = { Ok: SignEvent } | { Err: string };

/** Sign canister service 接口，定义所有可调用的 canister 方法 */
export interface SignService {
  /** 带 PoW 的签名（2 参数: SignParm + nonce 文本） */
  agent_sign: ActorMethod<[SignParm, string], SignResult>;
  /** 直接签名（无 PoW，需 canister 权限） */
  sign: ActorMethod<[SignParm], SignEvent>;
  /** MCP 代理签名 */
  mcp_sign: ActorMethod<[Principal, SignParm], SignEvent>;
  /** 获取全局计数器 */
  get_counter: ActorMethod<[], number>;
  /** 按计数器范围获取事件 */
  fetch_events_by_counter: ActorMethod<[number, number], SignEvent[]>;
  /** 获取所有签名事件 */
  get_all_sign_events: ActorMethod<[], SignEvent[]>;
  /** 获取用户签名历史（分页） */
  fetch_user_sign: ActorMethod<[Principal, number, number], [number, SignEvent[]]>;
  /** 获取用户最新签名事件 ID（PoW base） */
  get_user_latest_sign_event_id: ActorMethod<[Principal], string>;
  /** 通过消息内容验证签名 */
  verify_message: ActorMethod<[string], SignEvent[]>;
  /** 通过消息哈希验证签名 */
  verify_msg_hash: ActorMethod<[string], SignEvent[]>;
  /** 通过文件哈希验证签名 */
  verify_file_hash: ActorMethod<[string], SignEvent[]>;
  /** 通过 ID 获取签名事件 */
  get_sign_event_by_id: ActorMethod<[string], CandidOpt<SignEvent>>;
  /** 获取 Kind 1 身份档案 */
  get_kind1_event_by_principal: ActorMethod<[string], CandidOpt<SignEvent>>;
  /** 连接测试 */
  greet: ActorMethod<[string], string>;
}
