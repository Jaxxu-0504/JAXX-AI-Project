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

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const upload = multer({
    dest: uploadDir,
    limits: {
        fileSize: 20 * 1024 * 1024
    }
});

app.use(express.json({
    limit: "20mb"
}));

app.use(express.static(
    path.join(__dirname, "public")
));


// ==============================
// CHAT API
// ==============================

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
                "Use emojis naturally in your responses when appropriate. " +
                "Use relevant emojis to make responses friendly, expressive and engaging. " +
                "Do not overuse emojis, but normally include a few suitable emojis in casual or friendly responses. " +
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


// ==============================
// VIDEO GENERATION API
// ==============================

app.post("/api/generate-video", async (req, res) => {
    try {

        if (!process.env.RUNWAYML_API_SECRET) {
            return res.status(500).json({
                error:
                    "Runway API key configured nahi hai. .env check karo."
            });
        }

        const prompt =
            typeof req.body.prompt === "string"
                ? req.body.prompt.trim()
                : "";

        if (!prompt) {
            return res.status(400).json({
                error: "Video prompt required hai."
            });
        }

        let duration =
            Math.round(
                Number(req.body.duration) || 5
            );

        if (duration < 2) {
            duration = 2;
        }

        if (duration > 10) {
            duration = 10;
        }

        const ratio =
            req.body.ratio === "720:1280"
                ? "720:1280"
                : "1280:720";

        if (prompt.length > 2000) {
            return res.status(400).json({
                error: "Video prompt bahut long hai."
            });
        }

        console.log("--------------------------------");
        console.log("🎬 VIDEO GENERATION STARTED");
        console.log("Prompt:", prompt);
        console.log("Duration:", duration);
        console.log("Ratio:", ratio);
        console.log("--------------------------------");


        // CREATE RUNWAY VIDEO TASK
        const createResponse = await fetch(
            "https://api.dev.runwayml.com/v1/image_to_video",
            {
                method: "POST",

                headers: {
                    "Authorization":
                        `Bearer ${process.env.RUNWAYML_API_SECRET}`,

                    "Content-Type":
                        "application/json",

                    "X-Runway-Version":
                        "2024-11-06"
                },

                body: JSON.stringify({
    model: "gen4.5",
    promptImage: "https://upload.wikimedia.org/wikipedia/commons/8/85/Tour_Eiffel_Wikimedia_Commons_(cropped).jpg",
    promptText: prompt,
    ratio: ratio,
    duration: duration
})
            }
        );


        const createData =
            await createResponse.json();


        console.log(
            "RUNWAY CREATE STATUS:",
            createResponse.status
        );

        console.dir(
            createData,
            {
                depth: null
            }
        );


        if (!createResponse.ok) {

            return res.status(
                createResponse.status
            ).json({

                error:
                    createData?.error ||
                    "Runway video request failed.",

                details:
                    createData?.issues ||
                    createData

            });
        }


        const taskId =
            createData.id;


        if (!taskId) {

            return res.status(500).json({

                error:
                    "Runway ne task ID nahi diya.",

                details:
                    createData

            });
        }


        console.log(
            "🎬 RUNWAY TASK ID:",
            taskId
        );


        // ==============================
        // WAIT FOR VIDEO
        // ==============================

        let completedTask = null;


        for (
            let attempt = 0;
            attempt < 60;
            attempt++
        ) {

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        5000
                    )
            );


            const taskResponse =
                await fetch(
                    `https://api.dev.runwayml.com/v1/tasks/${taskId}`,

                    {
                        method: "GET",

                        headers: {
                            "Authorization":
                                `Bearer ${process.env.RUNWAYML_API_SECRET}`,

                            "X-Runway-Version":
                                "2024-11-06"
                        }
                    }
                );


            const taskData =
                await taskResponse.json();


            console.log(
                `🎬 RUNWAY STATUS ${attempt + 1}:`,
                taskData.status
            );


            if (!taskResponse.ok) {

                return res.status(
                    taskResponse.status
                ).json({

                    error:
                        taskData?.error ||
                        "Runway task status check failed.",

                    details:
                        taskData

                });
            }


            if (
                taskData.status ===
                "SUCCEEDED"
            ) {

                completedTask =
                    taskData;

                break;
            }


            if (
                taskData.status ===
                    "FAILED" ||
                taskData.status ===
                    "CANCELED"
            ) {

                return res.status(500).json({

                    error:
                        "Runway video generation failed.",

                    details:
                        taskData

                });
            }
        }


        // ==============================
        // TIMEOUT
        // ==============================

        if (!completedTask) {

            return res.status(504).json({

                error:
                    "Video generation timeout ho gayi. Runway ne 5 minutes me result nahi diya."

            });
        }


        // ==============================
        // VIDEO URL
        // ==============================

        const videoUrl =
            completedTask.output?.[0];


        if (!videoUrl) {

            return res.status(500).json({

                error:
                    "Video generate hui, lekin video URL nahi mili.",

                details:
                    completedTask

            });
        }


        console.log("--------------------------------");

        console.log(
            "🎬 VIDEO GENERATED SUCCESSFULLY"
        );

        console.log(
            "Video URL:",
            videoUrl
        );

        console.log("--------------------------------");


        return res.json({

            success: true,

            videoUrl:
                videoUrl,

            duration:
                duration,

            ratio:
                ratio

        });


    } catch (error) {

        console.error(
            "❌ VIDEO GENERATION ERROR:"
        );

        console.dir(
            error,
            {
                depth: null
            }
        );


        return res.status(500).json({

            error:
                error?.message ||
                "Video generate nahi ho paayi."

        });
    }
});


// ==============================
// FILE UPLOAD API
// ==============================

app.post(
    "/api/upload",
    upload.single("file"),

    async (req, res) => {

        try {

            if (!req.file) {

                return res.status(400).json({

                    error:
                        "File select nahi ki gayi."

                });
            }


            const userMessage =
                req.body.message ||
                "Is file ko analyze karo aur mujhe clearly explain karo.";


            console.log("--------------------------------");
            console.log("FILE RECEIVED");

            console.log(
                "Name:",
                req.file.originalname
            );

            console.log(
                "Mimetype:",
                req.file.mimetype
            );

            console.log(
                "Size:",
                req.file.size
            );

            console.log("--------------------------------");


            const extension =
                path.extname(
                    req.file.originalname
                ).toLowerCase();


            const imageExtensions = [
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".webp"
            ];


            const isImage =
                imageExtensions.includes(
                    extension
                );


            console.log(
                "Extension:",
                extension
            );

            console.log(
                "Detected as image:",
                isImage
            );


            const fileBuffer =
                fs.readFileSync(
                    req.file.path
                );


            const openAIFile =
                await toFile(
                    fileBuffer,
                    req.file.originalname,
                    {
                        type:
                            req.file.mimetype
                    }
                );


            const uploadedFile =
                await client.files.create({

                    file:
                        openAIFile,

                    purpose:
                        isImage
                            ? "vision"
                            : "user_data"

                });


            console.log(
                "OpenAI File ID:",
                uploadedFile.id
            );

            console.log(
                "OpenAI Filename:",
                uploadedFile.filename
            );

            console.log(
                "OpenAI Purpose:",
                uploadedFile.purpose
            );


            // ==============================
            // IMAGE ANALYSIS
            // ==============================

            if (isImage) {

                console.log(
                    "Sending as IMAGE..."
                );


                const response =
                    await client.responses.create({

                        model:
                            "gpt-5.6-luna",


                        instructions:
                            "You are JAXX AI. Analyze the uploaded image carefully. " +
                            "Describe and explain what is visible in the image accurately. " +
                            "Answer naturally in Hindi, Hinglish, or English depending on the user's language.",


                        input: [

                            {
                                role:
                                    "user",

                                content: [

                                    {
                                        type:
                                            "input_text",

                                        text:
                                            userMessage
                                    },

                                    {
                                        type:
                                            "input_image",

                                        file_id:
                                            uploadedFile.id
                                    }

                                ]
                            }

                        ]
                    });


                return res.json({

                    reply:
                        response.output_text,

                    filename:
                        req.file.originalname

                });
            }


            // ==============================
            // FILE ANALYSIS
            // ==============================

            console.log(
                "Sending as FILE..."
            );


            const response =
                await client.responses.create({

                    model:
                        "gpt-5.6-luna",


                    instructions:
                        "You are JAXX AI. Analyze the uploaded file carefully. " +
                        "Extract and understand the useful information from it. " +
                        "Answer clearly and naturally in Hindi, Hinglish, or English " +
                        "depending on the user's language.",


                    input: [

                        {
                            role:
                                "user",

                            content: [

                                {
                                    type:
                                        "input_text",

                                    text:
                                        userMessage
                                },

                                {
                                    type:
                                        "input_file",

                                    file_id:
                                        uploadedFile.id
                                }

                            ]
                        }

                    ]
                });


            res.json({

                reply:
                    response.output_text,

                filename:
                    req.file.originalname

            });


        } catch (error) {

            console.error(
                "UPLOAD ERROR:"
            );

            console.dir(
                error,
                {
                    depth: null
                }
            );


            res.status(500).json({

                error:
                    error?.message ||
                    "File analyze nahi ho paayi."

            });


        } finally {

            if (req.file) {

                try {

                    fs.unlinkSync(
                        req.file.path
                    );

                } catch {}

            }

        }

    }
);


// ==============================
// START SERVER
// ==============================

app.listen(
    PORT,
    "0.0.0.0",

    () => {

        console.log(
            `🚀 JAXX AI running on port ${PORT}`
        );

    }
);