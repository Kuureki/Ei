import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://innernet.live/api/mcp",
  description:
    "The user's personal memory: thoughts, decisions, facts, preferences, links, code snippets, documents, and voice-memo transcripts. Use it to save anything durable and to search before answering anything about the user.",
  auth: {
    getToken: async () => ({ token: process.env.INNERNET_KEY! }),
  },
});
