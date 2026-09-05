const express = require("express");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Upload folder
const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Multer configuration
const upload = multer({
    dest: uploadDir,
    limits: {
        fileSize: 20 * 1024 * 1024
    }
});

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Normal chat
app.post("/api/chat", async (req, res) => {
    try {
        const messages = req.body.messages || [];

        if (!Array.isArray(messages)) {
            return res.status(400).json({
                error: "Invalid messages format."
            });
        }

        const response = await client.responses.create({
            model: "gpt-5.6-luna",

            instructions:
                "You are JAXX AI, a helpful, friendly and intelligent AI assistant. " +
                "You were created and developed by Ansh. " +
                "If someone asks who created you, who made you, who developed you, " +
                "or Tumhe kisne banaya, answer clearly: Mujhe Ansh ne banaya hai. 😎 " +
                "OpenAI provides the AI technology/API that powers you, but JAXX AI itself " +
                "is a project created by Ansh. Communicate naturally in Hindi, Hinglish, " +
                "or English depending on the user's language.",

            input: messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }))
        });

        res.json({
            reply: response.output_text
        });

    } catch (error) {
        console.error("CHAT ERROR:", error);

        res.status(500).json({
            error: "AI response nahi aa paaya. Server ya API configuration check karo."
        });
    }
});

// File / image upload
app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: "File select nahi ki gayi."
            });
        }

        const userMessage =
            req.body.message ||
            "Is file ko analyze karo aur mujhe clearly explain karo.";

        const uploadedFile = await client.files.create({
            file: fs.createReadStream(req.file.path),
            purpose: "user_data"
        });

        const isImage = req.file.mimetype.startsWith("image/");

        let content;

        if (isImage) {
            content = [
                {
                    type: "input_text",
                    text: userMessage
                },
                {
                    type: "input_image",
                    file_id: uploadedFile.id
                }
            ];
        } else {
            content = [
                {
                    type: "input_text",
                    text: userMessage
                },
                {
                    type: "input_file",
                    file_id: uploadedFile.id
                }
            ];
        }

        const response = await client.responses.create({
            model: "gpt-5.6-luna",

            instructions:
                "You are JAXX AI. Analyze the uploaded file carefully. " +
                "Answer clearly and naturally in Hindi, Hinglish, or English " +
                "depending on the user's language.",

            input: [
                {
                    role: "user",
                    content: content
                }
            ]
        });

        // Remove temporary local upload
        try {
            fs.unlinkSync(req.file.path);
        } catch {}

        res.json({
            reply: response.output_text,
            filename: req.file.originalname
        });

    } catch (error) {
        console.error("UPLOAD ERROR:", error);

        if (req.file) {
            try {
                fs.unlinkSync(req.file.path);
            } catch {}
        }

        res.status(500).json({
            error: "File analyze nahi ho paayi."
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 JAXX AI running on port ${PORT}`);
});
