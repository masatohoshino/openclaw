import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { hasNextcloudTalkImplicitDefaultAccount } from "../configured-state.js";

export const channelSecrets = createSimpleChannelSecretContract({
  channelKey: "nextcloud-talk",
  label: "Nextcloud Talk",
  accountFields: ["apiPassword", "botSecret"],
  channelFields: ["apiPassword", "botSecret"],
  mode: {
    kind: "surface-inheritance",
    // Runtime collection historically reports botSecret before apiPassword.
    collectionFields: ["botSecret", "apiPassword"],
  },
  hasImplicitDefaultAccount: ({ context }) =>
    hasNextcloudTalkImplicitDefaultAccount(context.sourceConfig, context.env),
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
