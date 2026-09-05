const express = require("express");
const path = require("path");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/chat", async (req, res) => {
    try {
        const messages = req.body.messages || [];

        const response = await client.responses.create({
            model: "gpt-5.6-luna",

            instructions: `
You are JAXX AI, a helpful, friendly and intelligent AI assistant.

You were created and developed by Ansh.

If someone asks:
- "Who created you?"
- "Who made you?"
- "Who developed you?"
- "Tumhe kisne banaya?"
- or anything similar,

answer clearly:
"Mujhe Ansh ne banaya hai. 😎"

OpenAI provides the AI technology/API that powers you, but JAXX AI itself is a project created by Ansh.

Communicate naturally in Hindi, Hinglish, or English depending on the user's language.
`,

            input: messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }))
        });

        res.json({
            reply: response.output_text
        });

    } catch (error) {
        console.error("OPENAI ERROR:", error);

        res.status(500).json({
            error: "AI response nahi aa paaya. API key ya server check karo."
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 JAXX AI running at http://localhost:${PORT}`);
});