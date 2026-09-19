import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { isAllowedIMessageSender } from "../targets.js";
import { mergeIMessageGroupAllowFromWithLegacyChatTargets } from "./inbound-processing.js";
import type { IMessagePayload } from "./types.js";

export async function readIMessageInboundStoreAllowFrom(params: {
  message: IMessagePayload;
  cfg: OpenClawConfig;
  accountId: string;
  dmPolicy: string;
  groupAllowFrom: string[];
  allowFrom: string[];
  allowLegacyConversationAllowFromForGroup?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  if (!isIMessagePairingStoreRequired(params)) {
    return [];
  }
  return await readChannelAllowFromStore("imessage", params.env ?? process.env, params.accountId);
}

function isIMessagePairingStoreRequired(params: {
  message: IMessagePayload;
  cfg: OpenClawConfig;
  accountId: string;
  dmPolicy: string;
  groupAllowFrom: string[];
  allowFrom: string[];
  allowLegacyConversationAllowFromForGroup?: boolean;
}): boolean {
  // Shared ingress admits open/allowlist DMs, groups, and configured allowFrom
  // matches without stored pairing approval.
  if (params.dmPolicy === "open" || params.dmPolicy === "allowlist") {
    return false;
  }
  if (params.message.is_group) {
    return false;
  }
  if (
    isAllowedIMessageSender({
      allowFrom: params.allowFrom,
      sender: params.message.sender ?? "",
    })
  ) {
    return false;
  }
  const chatId = params.message.chat_id;
  if (chatId === undefined || chatId === null) {
    return true;
  }
  const groupAllowFromWithLegacy = mergeIMessageGroupAllowFromWithLegacyChatTargets({
    groupAllowFrom: params.groupAllowFrom,
    allowFrom: params.allowFrom,
    allowLegacyConversationTargets: params.allowLegacyConversationAllowFromForGroup,
  });
  const groupListPolicy = resolveChannelGroupPolicy({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    groupId: String(chatId),
    hasGroupAllowFrom: groupAllowFromWithLegacy.length > 0,
  });
  return !(groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig);
}
