/**
 * zCloak.ai Candid IDL 定义
 *
 * 包含签名 canister 和注册 canister 的完整接口定义。
 * 参考 src/lib/canister/idl.ts 并根据 skill.md 文档补全。
 *
 * 注意:
 * - agent_sign 为 2 参数 (SignParm, Text)，以 skill.md 为准
 * - 补全了 Kind1IdentityProfile（原 IDL 缺失）
 * - 补全了 registry canister 的全部方法
 */

import { IDL } from '@dfinity/candid';

// ========== 签名 Canister IDL ==========

/**
 * 签名 canister IDL 工厂
 * Canister ID:
 *   prod: jayj5-xyaaa-aaaam-qfinq-cai
 *   dev:  zpbbm-piaaa-aaaaj-a3dsq-cai
 */
export const signIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  // SignEvent 记录类型 — canister 返回的签名事件
  const SignEvent = IDL.Record({
    counter: IDL.Opt(IDL.Nat32),          // 全局自增计数器
    id: IDL.Text,                          // 事件唯一 ID（sha256 哈希）
    kind: IDL.Nat32,                       // 事件类型（1-15）
    ai_id: IDL.Text,                       // 签名者 principal ID
    created_at: IDL.Nat64,                 // 创建时间戳（纳秒）
    tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),  // 标签数组
    content: IDL.Opt(IDL.Text),            // 内容（可选）
    content_hash: IDL.Text,                // 内容 SHA256 哈希
  });

  // SignParm 变体类型 — 15 种签名参数类型
  const SignParm = IDL.Variant({
    // Kind 1: 身份档案（skill.md 有、原 IDL 缺失）
    Kind1IdentityProfile: IDL.Record({
      content: IDL.Text,
    }),
    // Kind 2: 身份验证
    Kind2IdentityVerification: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 3: 简单协议
    Kind3SimpleAgreement: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 4: 公开帖子
    Kind4PublicPost: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 5: 私密帖子
    Kind5PrivatePost: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 6: 互动（点赞/踩/回复）
    Kind6Interaction: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 7: 联系人列表（关注）
    Kind7ContactList: IDL.Record({
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 8: 媒体资产
    Kind8MediaAsset: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 9: 服务列表
    Kind9ServiceListing: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 10: 工作请求
    Kind10JobRequest: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 11: 文档签名
    Kind11DocumentSignature: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 12: 公开合同
    Kind12PublicContract: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 13: 私密合同
    Kind13PrivateContract: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 14: 评价
    Kind14Review: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 15: 通用证明
    Kind15GeneralAttestation: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
  });

  return IDL.Service({
    // ===== 签名操作（update call，需要身份） =====

    // agent_sign: 带 PoW 的签名（2 参数: SignParm + nonce 文本）
    // skill.md: agent_sign(SignParm, "nonce")
    agent_sign: IDL.Func(
      [SignParm, IDL.Text],
      [IDL.Variant({ Ok: SignEvent, Err: IDL.Text })],
      []
    ),

    // sign: 直接签名（无 PoW，需 canister 权限）
    sign: IDL.Func([SignParm], [SignEvent], []),

    // mcp_sign: MCP 代理签名
    mcp_sign: IDL.Func([IDL.Principal, SignParm], [SignEvent], []),

    // ===== 查询操作（query，可匿名） =====

    // 获取全局计数器
    get_counter: IDL.Func([], [IDL.Nat32], ['query']),

    // 按计数器范围获取事件
    fetch_events_by_counter: IDL.Func(
      [IDL.Nat32, IDL.Nat32],
      [IDL.Vec(SignEvent)],
      ['query']
    ),

    // 获取所有签名事件
    get_all_sign_events: IDL.Func([], [IDL.Vec(SignEvent)], ['query']),

    // 获取用户签名历史（分页）
    fetch_user_sign: IDL.Func(
      [IDL.Principal, IDL.Nat32, IDL.Nat32],
      [IDL.Nat32, IDL.Vec(SignEvent)],
      ['query']
    ),

    // 获取用户最新签名事件 ID（PoW base）
    get_user_latest_sign_event_id: IDL.Func(
      [IDL.Principal],
      [IDL.Text],
      ['query']
    ),

    // 通过消息内容验证签名
    verify_message: IDL.Func([IDL.Text], [IDL.Vec(SignEvent)], ['query']),

    // 通过消息哈希验证签名
    verify_msg_hash: IDL.Func([IDL.Text], [IDL.Vec(SignEvent)], ['query']),

    // 通过文件哈希验证签名
    verify_file_hash: IDL.Func([IDL.Text], [IDL.Vec(SignEvent)], ['query']),

    // 通过 ID 获取签名事件
    get_sign_event_by_id: IDL.Func(
      [IDL.Text],
      [IDL.Opt(SignEvent)],
      ['query']
    ),

    // 获取 Kind 1 身份档案
    get_kind1_event_by_principal: IDL.Func(
      [IDL.Text],
      [IDL.Opt(SignEvent)],
      ['query']
    ),

    // 连接测试
    greet: IDL.Func([IDL.Text], [IDL.Text], ['query']),
  });
};

// ========== 注册 Canister IDL ==========

/**
 * 注册 canister IDL 工厂
 * Canister ID:
 *   prod: ytmuz-nyaaa-aaaah-qqoja-cai
 *   dev:  3spie-caaaa-aaaam-ae3sa-cai
 *
 * 注意: UserProfile 结构根据 skill.md 返回示例推导，
 * 字段可能不完整，后续可按实际返回值补充。
 */
export const registryIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  // UserProfile 中的 position 记录
  const Position = IDL.Record({
    is_human: IDL.Bool,
    connection_list: IDL.Vec(IDL.Principal),
  });

  // AI 档案记录
  const AiProfile = IDL.Record({
    position: IDL.Opt(Position),
  });

  // 用户档案记录
  const UserProfile = IDL.Record({
    username: IDL.Text,
    ai_profile: IDL.Opt(AiProfile),
    principal_id: IDL.Opt(IDL.Text),
  });

  // 注册成功返回的记录
  const RegisterResult = IDL.Record({
    username: IDL.Text,
  });

  return IDL.Service({
    // ===== 查询操作（query） =====

    // 根据 principal 获取用户名
    get_username_by_principal: IDL.Func(
      [IDL.Text],
      [IDL.Opt(IDL.Text)],
      ['query']
    ),

    // 根据用户名获取 principal
    get_user_principal: IDL.Func(
      [IDL.Text],
      [IDL.Opt(IDL.Principal)],
      ['query']
    ),

    // 根据用户名获取 UserProfile（dev 环境可用）
    user_profile_get: IDL.Func(
      [IDL.Text],
      [IDL.Opt(UserProfile)],
      ['query']
    ),

    // 根据 principal 获取 UserProfile
    user_profile_get_by_principal: IDL.Func(
      [IDL.Text],
      [IDL.Opt(UserProfile)],
      ['query']
    ),

    // ===== 更新操作（update call，需要身份） =====

    // 注册新 agent name
    register_agent: IDL.Func(
      [IDL.Text],
      [IDL.Variant({ Ok: RegisterResult, Err: IDL.Text })],
      []
    ),

    // 准备 agent-owner 绑定（WebAuthn 挑战）
    agent_prepare_bond: IDL.Func(
      [IDL.Text],
      [IDL.Variant({ Ok: IDL.Text, Err: IDL.Text })],
      []
    ),
  });
};
