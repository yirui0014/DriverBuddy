// ============================================================================
// File: agent.js
// Purpose: Configures DriveBuddy’s AI co-pilot agent using LangChain + Gemini.
// The agent handles driver conversations and delegates specific tasks
// (like weather or rest stop queries) to specialized LangChain tools.
// It maintains lightweight context via checkpoint memory.
// ============================================================================
import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import z from "zod";
import { weatherTool } from "./tools/weatherTool.js";
import { weatherRouteTool } from "./tools/weatherRouteTool.js";
import { restStopTool } from "./tools/restStopTool.js";

/** ───────────────── LLM ───────────────── **/
const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash",
  apiKey: process.env.VITE_GEMINI_API_KEY,
});

const checkpointSaver = new MemorySaver();


/** ─────────────── Agent ─────────────── **/
const SYSTEM = `
You are DriveBuddy, a concise, friendly co-pilot.
Your MAIN role is to have light, supportive, and non-distracting conversations with the driver.
- You MAY call TOOLS **only when the driver explicitly asks about WEATHER, ROUTE WEATHER, or REST STOPS**.
- If the driver seems drowsy or asks for places to rest (R&R, petrol, parking), call "findRestStop".
- For all other requests (stories, jokes, trivia, quick chat), just respond directly in a friendly way.
- If the user asks for weather at ONE location (or "here"), call the "weather" tool.
- If the user asks about TWO locations (A to B), or "along the way" / "on the drive", call "weatherRoute".
- Do not handle more than two locations.
Keep replies short (≤2 sentences), encouraging, and safe for driving.
Avoid deep focus tasks or anything that could distract the driver.
`;

export const agent = createReactAgent({
  llm,
  tools: [weatherTool, weatherRouteTool],
  checkpointSaver,
  messageModifier: SYSTEM,
});
