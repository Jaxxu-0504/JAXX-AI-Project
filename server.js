const express = require("express");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
require("dotenv").config();

const OpenAI = require("openai");
const { toFile } = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// =====================================================
// UPLOAD FOLDER
// =====================================================

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// =====================================================
// MULTER
// =====================================================

const upload = multer({
    dest: uploadDir,
    limits: {
        fileSize: 20 * 1024 * 1024
    }
});

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// =====================================================
// NORMAL CHAT
// =====================================================

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
            error:
                "AI response nahi aa paaya. Server ya API configuration check karo."
        });
    }
});

// =====================================================
// FILE / IMAGE UPLOAD
// =====================================================

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

        console.log("--------------------------------");
        console.log("FILE RECEIVED");
        console.log("Name:", req.file.originalname);
        console.log("Mimetype:", req.file.mimetype);
        console.log("Size:", req.file.size);
        console.log("--------------------------------");

        // =================================================
        // DETECT FILE TYPE
        // =================================================

        const extension =
            path.extname(req.file.originalname).toLowerCase();

        const imageExtensions = [
            ".jpg",
            ".jpeg",
            ".png",
            ".gif",
            ".webp"
        ];

        const isImage =
            imageExtensions.includes(extension);

        console.log("Extension:", extension);
        console.log("Detected as image:", isImage);

        // =================================================
        // IMPORTANT:
        // Give OpenAI the ORIGINAL filename.
        // Multer's temporary file has no extension.
        // =================================================

        const fileBuffer = fs.readFileSync(req.file.path);

        const openAIFile = await toFile(
            fileBuffer,
            req.file.originalname,
            {
                type: req.file.mimetype
            }
        );

        // =================================================
        // UPLOAD TO OPENAI
        // =================================================

        const uploadedFile = await client.files.create({

            file: openAIFile,

            purpose: isImage
                ? "vision"
                : "user_data"
        });

        console.log("OpenAI File ID:", uploadedFile.id);
        console.log("OpenAI Filename:", uploadedFile.filename);
        console.log("OpenAI Purpose:", uploadedFile.purpose);

        // =================================================
        // IMAGE
        // =================================================

        if (isImage) {

            console.log("Sending as IMAGE...");

            const response =
                await client.responses.create({

                    model: "gpt-5.6-luna",

                    instructions:
                        "You are JAXX AI. Analyze the uploaded image carefully. " +
                        "Describe and explain what is visible in the image accurately. " +
                        "Answer naturally in Hindi, Hinglish, or English depending on the user's language.",

                    input: [
                        {
                            role: "user",

                            content: [

                                {
                                    type: "input_text",
                                    text: userMessage
                                },

                                {
                                    type: "input_image",
                                    file_id: uploadedFile.id
                                }

                            ]
                        }
                    ]
                });

            return res.json({

                reply: response.output_text,

                filename:
                    req.file.originalname

            });
        }

        // =================================================
        // PDF / DOC / TXT / CSV / OTHER FILE
        // =================================================

        console.log("Sending as FILE...");

        const response =
            await client.responses.create({

                model: "gpt-5.6-luna",

                instructions:
                    "You are JAXX AI. Analyze the uploaded file carefully. " +
                    "Extract and understand the useful information from it. " +
                    "Answer clearly and naturally in Hindi, Hinglish, or English " +
                    "depending on the user's language.",

                input: [
                    {
                        role: "user",

                        content: [

                            {
                                type: "input_text",
                                text: userMessage
                            },

                            {
                                type: "input_file",
                                file_id: uploadedFile.id
                            }

                        ]
                    }
                ]
            });

        res.json({

            reply: response.output_text,

            filename:
                req.file.originalname

        });

    } catch (error) {

        console.error("UPLOAD ERROR:", error);

        res.status(500).json({

            error:
                error?.message ||
                "File analyze nahi ho paayi."

        });

    } finally {

        // =================================================
        // DELETE TEMPORARY LOCAL FILE
        // =================================================

        if (req.file) {

            try {

                fs.unlinkSync(req.file.path);

            } catch {}

        }

    }

});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `🚀 JAXX AI running on port ${PORT}`
    );

});