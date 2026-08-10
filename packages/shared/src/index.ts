// @ei/shared — pure helpers shared by the agent and the connector.
export { isPublicHttpUrl } from "./nets";
export { decodeToken, encodeToken, splitReply } from "./discord-util";
export type { DiscordAddress } from "./discord-util";
export const SHARED_VERSION = "0.1.0";
