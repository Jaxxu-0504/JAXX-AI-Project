// ============================================================
// JAXX AI - SERVER.JS
// PART 1
// ============================================================

require("dotenv").config();

const express = require("express");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

const { Pool } = require("pg");

let Stripe = null;

try {
    Stripe = require("stripe");
} catch (error) {
    console.log("Stripe package not available yet.");
}


// ============================================================
// APP CONFIG
// ============================================================

const app = express();

const PORT =
    process.env.PORT || 3000;

const openaiApiKey =
    process.env.OPENAI_API_KEY;

const JWT_SECRET =
    process.env.JWT_SECRET;

const client =
    new OpenAI({
        apiKey: openaiApiKey
    });


// ============================================================
// DATABASE
// ============================================================

if (!process.env.DATABASE_URL) {

    console.error(
        "❌ DATABASE_URL missing."
    );

    process.exit(1);
}

const pool =
    new Pool({
        connectionString:
            process.env.DATABASE_URL,

        ssl: {
            rejectUnauthorized: false
        }
    });


// ============================================================
// STRIPE
// ============================================================

let stripe = null;

if (
    Stripe &&
    process.env.STRIPE_SECRET_KEY
) {

    stripe =
        new Stripe(
            process.env.STRIPE_SECRET_KEY
        );
}


// ============================================================
// OPENAI MODEL
// ============================================================

const OPENAI_MODEL =
    "gpt-5.6-luna";


// ============================================================
// PLANS
// ============================================================

const PLANS = {

    free: {
        id: "free",
        name: "Free",
        price: 0,

        video: false,
        upload: false,

        // Free users get limited image generation.
        image: true
    },

    pro: {
        id: "pro",
        name: "Pro",
        price: 199,

        video: true,
        upload: true,
        image: true
    },

    pro_plus: {
        id: "pro_plus",
        name: "Pro+",
        price: 399,

        video: true,
        upload: true,
        image: true
    },
     owner: {
    id: "owner",
    name: "Owner",
    price: 0,

    video: true,
    upload: true,
    image: true
    }

};


// ============================================================
// FREE IMAGE LIMIT
// ============================================================

const FREE_IMAGE_LIMIT = 3;

const FREE_IMAGE_WINDOW_HOURS = 48;


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
    express.json({
        limit: "20mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "20mb"
    })
);

app.use(
    cookieParser()
);


// ============================================================
// STATIC FRONTEND
// ============================================================

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


// ============================================================
// AUTH HELPERS
// ============================================================

function createToken(user) {

    return jwt.sign(
        {
            id: user.id,
            email: user.email
        },
        JWT_SECRET,
        {
            expiresIn: "7d"
        }
    );
}


function setAuthCookie(
    res,
    token
) {

    res.cookie(
        "jaxx_token",
        token,
        {
            httpOnly: true,

            secure:
                process.env.NODE_ENV ===
                "production",

            sameSite: "lax",

            maxAge:
                7 *
                24 *
                60 *
                60 *
                1000
        }
    );
}


function clearAuthCookie(
    res
) {

    res.clearCookie(
        "jaxx_token",
        {
            httpOnly: true,

            secure:
                process.env.NODE_ENV ===
                "production",

            sameSite: "lax"
        }
    );
}


// ============================================================
// AUTH MIDDLEWARE
// ============================================================

async function requireAuth(
    req,
    res,
    next
) {

    try {

        const token =
            req.cookies?.jaxx_token;

        if (!token) {

            return res.status(401).json({
                error:
                    "Login required hai.",
                code:
                    "AUTH_REQUIRED"
            });
        }


        let payload;

        try {

            payload =
                jwt.verify(
                    token,
                    JWT_SECRET
                );

        } catch (error) {

            clearAuthCookie(res);

            return res.status(401).json({
                error:
                    "Session expire ho gaya. Dobara login karo.",
                code:
                    "AUTH_REQUIRED"
            });
        }


        const result =
            await pool.query(
                `
                SELECT
                    id,
                    name,
                    email,
                    plan,
                    stripe_customer_id,
                    stripe_subscription_id,
                    created_at
                FROM users
                WHERE id = $1
                `,
                [
                    payload.id
                ]
            );


        if (
            result.rows.length === 0
        ) {

            clearAuthCookie(res);

            return res.status(401).json({
                error:
                    "User account nahi mila.",
                code:
                    "AUTH_REQUIRED"
            });
        }


        req.user =
            result.rows[0];

        req.dbUser =
            result.rows[0];


        next();

    } catch (error) {

        console.error(
            "AUTH ERROR:",
            error
        );

        return res.status(500).json({
            error:
                "Authentication error."
        });
    }
}


// ============================================================
// PLAN MIDDLEWARE
// ============================================================

function requirePlan(
    requiredPlans
) {

    return async function (
        req,
        res,
        next
    ) {

        try {

            if (!req.user) {

                return res.status(401).json({
                    error:
                        "Login required hai.",
                    code:
                        "AUTH_REQUIRED"
                });
            }


            const userPlan =
                req.user.plan ||
                "free";


            if (
    userPlan !== "owner" &&
    !requiredPlans.includes(userPlan)
) {

                return res.status(403).json({
                    error:
                        "Ye feature Premium plan ke liye available hai.",
                    code:
                        "PREMIUM_REQUIRED"
                });
            }


            next();

        } catch (error) {

            console.error(
                "PLAN CHECK ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "Plan check nahi ho paaya."
            });
        }
    };
}
// ============================================================
// GET FRESH USER
// ============================================================

async function getFreshUser(userId) {

    const result =
        await pool.query(
            `
            SELECT
                id,
                name,
                email,
                plan,
                stripe_customer_id,
                stripe_subscription_id,
                created_at
            FROM users
            WHERE id = $1
            `,
            [
                userId
            ]
        );

    if (
        result.rows.length === 0
    ) {
        return null;
    }

    return result.rows[0];
}

// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,

            name TEXT NOT NULL,

            email TEXT UNIQUE NOT NULL,

            password_hash TEXT NOT NULL,

            plan TEXT NOT NULL
                DEFAULT 'free',

            stripe_customer_id TEXT,

            stripe_subscription_id TEXT,

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        )
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_conversations (
            id SERIAL PRIMARY KEY,

            user_id INTEGER NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,

            title TEXT NOT NULL
                DEFAULT 'New Chat',

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP,

            updated_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        )
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,

            user_id INTEGER NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,

            conversation_id INTEGER
                REFERENCES chat_conversations(id)
                ON DELETE CASCADE,

            role TEXT NOT NULL,

            content TEXT NOT NULL,

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        )
    `);


    // ========================================================
    // FREE IMAGE USAGE TABLE
    // ========================================================

    await pool.query(`
        CREATE TABLE IF NOT EXISTS image_generation_usage (
            id SERIAL PRIMARY KEY,

            user_id INTEGER NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,

            generated_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        )
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_image_generation_usage_user_time
        ON image_generation_usage
        (
            user_id,
            generated_at
        )
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_chat_conversations_user_updated
        ON chat_conversations
        (
            user_id,
            updated_at DESC
        )
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_chat_messages_conversation
        ON chat_messages
        (
            conversation_id,
            created_at
        )
    `);


    // ========================================================
    // OLD MESSAGES MIGRATION
    // ========================================================

    const oldMessages =
        await pool.query(`
            SELECT
                DISTINCT user_id
            FROM chat_messages
            WHERE conversation_id IS NULL
        `);


    for (
        const row of oldMessages.rows
    ) {

        const conversation =
            await pool.query(
                `
                INSERT INTO
                    chat_conversations
                    (
                        user_id,
                        title
                    )
                VALUES
                    (
                        $1,
                        $2
                    )
                RETURNING id
                `,
                [
                    row.user_id,
                    "Previous Chats"
                ]
            );


        await pool.query(
            `
            UPDATE chat_messages
            SET conversation_id = $1
            WHERE user_id = $2
            AND conversation_id IS NULL
            `,
            [
                conversation.rows[0].id,
                row.user_id
            ]
        );
    }


    console.log(
        "✅ Database initialized."
    );
}


// ============================================================
// FREE IMAGE USAGE HELPERS
// ============================================================

async function getFreeImageUsage(
    userId
) {

    const result =
        await pool.query(
            `
            SELECT
                COUNT(*)::int AS count
            FROM image_generation_usage
            WHERE user_id = $1
            AND generated_at >=
                CURRENT_TIMESTAMP
                - INTERVAL '48 hours'
            `,
            [
                userId
            ]
        );


    return (
        result.rows[0]?.count ||
        0
    );
}


// ============================================================
// RESERVE FREE IMAGE SLOT
// ============================================================

async function reserveFreeImageGeneration(
    userId
) {

    const db =
        await pool.connect();

    try {

        await db.query(
            "BEGIN"
        );


        // Lock the user's row so two
        // simultaneous requests cannot
        // bypass the 3-image limit.

        await db.query(
            `
            SELECT id
            FROM users
            WHERE id = $1
            FOR UPDATE
            `,
            [
                userId
            ]
        );


        const result =
            await db.query(
                `
                SELECT
                    COUNT(*)::int AS count
                FROM image_generation_usage
                WHERE user_id = $1
                AND generated_at >=
                    CURRENT_TIMESTAMP
                    - INTERVAL '48 hours'
                `,
                [
                    userId
                ]
            );


        const used =
            result.rows[0]?.count ||
            0;


        if (
            used >=
            FREE_IMAGE_LIMIT
        ) {

            await db.query(
                "ROLLBACK"
            );


            return {
                allowed: false,

                used: used,

                remaining: 0,

                reservationId: null
            };
        }


        const inserted =
            await db.query(
                `
                INSERT INTO
                    image_generation_usage
                    (
                        user_id,
                        generated_at
                    )
                VALUES
                    (
                        $1,
                        CURRENT_TIMESTAMP
                    )
                RETURNING id
                `,
                [
                    userId
                ]
            );


        await db.query(
            "COMMIT"
        );


        return {
            allowed: true,

            used:
                used + 1,

            remaining:
                Math.max(
                    0,
                    FREE_IMAGE_LIMIT -
                    (used + 1)
                ),

            reservationId:
                inserted.rows[0].id
        };


    } catch (error) {

        try {
            await db.query(
                "ROLLBACK"
            );
        } catch {}


        throw error;

    } finally {

        db.release();
    }
}


// ============================================================
// RELEASE IMAGE RESERVATION
// ============================================================

async function releaseFreeImageReservation(
    reservationId
) {

    if (!reservationId) {
        return;
    }


    try {

        await pool.query(
            `
            DELETE FROM
                image_generation_usage
            WHERE id = $1
            `,
            [
                reservationId
            ]
        );

    } catch (error) {

        console.error(
            "IMAGE RESERVATION RELEASE ERROR:",
            error
        );
    }
}


// ============================================================
// BASIC ROUTES
// ============================================================

app.get(
    "/api/health",
    (req, res) => {

        return res.json({
            success: true,
            message:
                "JAXX AI server is running."
        });
    }
);


app.get(
    "/api/plans",
    (req, res) => {

        return res.json({
            plans: PLANS
        });
    }
);


// ============================================================
// SIGNUP
// ============================================================

app.post(
    "/api/signup",
    async (req, res) => {

        try {

            const name =
                typeof req.body.name ===
                "string"
                    ? req.body.name.trim()
                    : "";

            const email =
                typeof req.body.email ===
                "string"
                    ? req.body.email
                        .trim()
                        .toLowerCase()
                    : "";

            const password =
                typeof req.body.password ===
                "string"
                    ? req.body.password
                    : "";


            if (!name) {

                return res.status(400).json({
                    error:
                        "Name required hai."
                });
            }


            if (!email) {

                return res.status(400).json({
                    error:
                        "Email required hai."
                });
            }


            if (
                password.length < 6
            ) {

                return res.status(400).json({
                    error:
                        "Password kam se kam 6 characters ka hona chahiye."
                });
            }


            const existing =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE email = $1
                    `,
                    [
                        email
                    ]
                );


            if (
                existing.rows.length > 0
            ) {

                return res.status(409).json({
                    error:
                        "Is email se account already bana hua hai."
                });
            }


            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );


            const result =
                await pool.query(
                    `
                    INSERT INTO users
                        (
                            name,
                            email,
                            password_hash,
                            plan
                        )
                    VALUES
                        (
                            $1,
                            $2,
                            $3,
                            'free'
                        )
                    RETURNING
                        id,
                        name,
                        email,
                        plan,
                        created_at
                    `,
                    [
                        name,
                        email,
                        passwordHash
                    ]
                );


            const user =
                result.rows[0];


            const token =
                createToken(
                    user
                );


            setAuthCookie(
                res,
                token
            );


            return res.status(201).json({
                success: true,

                user: user,

                message:
                    "Account created successfully 🎉"
            });


        } catch (error) {

            console.error(
                "SIGNUP ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "Account create nahi ho paaya."
            });
        }
    }
);
// ============================================================
// LOGIN
// ============================================================

app.post(
    "/api/login",
    async (req, res) => {

        try {

            const email =
                typeof req.body.email ===
                "string"
                    ? req.body.email
                        .trim()
                        .toLowerCase()
                    : "";

            const password =
                typeof req.body.password ===
                "string"
                    ? req.body.password
                    : "";


            if (!email || !password) {

                return res.status(400).json({
                    error:
                        "Email aur password required hai."
                });
            }


            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        email,
                        password_hash,
                        plan,
                        stripe_customer_id,
                        stripe_subscription_id,
                        created_at
                    FROM users
                    WHERE email = $1
                    `,
                    [
                        email
                    ]
                );


            if (
                result.rows.length === 0
            ) {

                return res.status(401).json({
                    error:
                        "Email ya password galat hai."
                });
            }


           const user =
    result.rows[0];


// OWNER ACCESS
if (user.email === "anshr97209@gmail.com") {
    await pool.query(
        `
        UPDATE users
        SET plan = 'owner'
        WHERE id = $1
        `,
        [user.id]
    );

    user.plan = "owner";
}


const passwordMatch =
    await bcrypt.compare(
        password,
        user.password_hash
    );


            if (!passwordMatch) {

                return res.status(401).json({
                    error:
                        "Email ya password galat hai."
                });
            }


            const token =
                createToken(
                    user
                );


            setAuthCookie(
                res,
                token
            );


            return res.json({
                success: true,

                user: {
                    id:
                        user.id,

                    name:
                        user.name,

                    email:
                        user.email,

                    plan:
                        user.plan,

                    createdAt:
                        user.created_at
                },

                message:
                    "Login successful 👋"
            });


        } catch (error) {

            console.error(
                "LOGIN ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "Login nahi ho paaya."
            });
        }
    }
);


// ============================================================
// CURRENT USER
// ============================================================

app.get(
    "/api/me",
    async (req, res) => {

        try {

            const token =
                req.cookies?.jaxx_token;


            if (!token) {

                return res.json({
                    loggedIn: false
                });
            }


            let payload;

            try {

                payload =
                    jwt.verify(
                        token,
                        JWT_SECRET
                    );

            } catch {

                clearAuthCookie(
                    res
                );

                return res.json({
                    loggedIn: false
                });
            }


            const user =
                await getFreshUser(
                    payload.id
                );


            if (!user) {

                clearAuthCookie(
                    res
                );

                return res.json({
                    loggedIn: false
                });
            }


            return res.json({

                loggedIn: true,

                user: {

                    id:
                        user.id,

                    name:
                        user.name,

                    email:
                        user.email,

                    plan:
                        user.plan,

                    createdAt:
                        user.created_at
                }
            });


        } catch (error) {

            console.error(
                "ME ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "User information nahi mil paayi."
            });
        }
    }
);


// ============================================================
// LOGOUT
// ============================================================

app.post(
    "/api/logout",
    (req, res) => {

        clearAuthCookie(
            res
        );


        return res.json({
            success: true,

            message:
                "Logout successful."
        });
    }
);


// ============================================================
// CONVERSATIONS - GET
// ============================================================

app.get(
    "/api/conversations",
    requireAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        title,
                        created_at,
                        updated_at
                    FROM chat_conversations
                    WHERE user_id = $1
                    ORDER BY
                        updated_at DESC,
                        id DESC
                    `,
                    [
                        req.user.id
                    ]
                );


            return res.json({

                success: true,

                conversations:
                    result.rows.map(
                        conversation => ({

                            id:
                                conversation.id,

                            title:
                                conversation.title,

                            createdAt:
                                conversation.created_at,

                            updatedAt:
                                conversation.updated_at
                        })
                    )
            });


        } catch (error) {

            console.error(
                "CONVERSATIONS ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "Chat history load nahi ho paayi."
            });
        }
    }
);


// ============================================================
// CREATE CONVERSATION
// ============================================================

app.post(
    "/api/conversations",
    requireAuth,
    async (req, res) => {

        try {

            const title =
                typeof req.body.title ===
                "string" &&
                req.body.title.trim()
                    ? req.body.title
                        .trim()
                        .slice(0, 200)
                    : "New Chat";


            const result =
                await pool.query(
                    `
                    INSERT INTO
                        chat_conversations
                        (
                            user_id,
                            title
                        )
                    VALUES
                        (
                            $1,
                            $2
                        )
                    RETURNING
                        id,
                        title,
                        created_at,
                        updated_at
                    `,
                    [
                        req.user.id,
                        title
                    ]
                );


            const conversation =
                result.rows[0];


            return res.status(201).json({

                success: true,

                conversation: {

                    id:
                        conversation.id,

                    title:
                        conversation.title,

                    createdAt:
                        conversation.created_at,

                    updatedAt:
                        conversation.updated_at
                }
            });


        } catch (error) {

            console.error(
                "CREATE CONVERSATION ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "New chat create nahi ho paayi."
            });
        }
    }
);


// ============================================================
// GET CHAT HISTORY
// ============================================================

app.get(
    "/api/chat-history",
    requireAuth,
    async (req, res) => {

        try {

            const conversationId =
                Number(
                    req.query.chatId
                );


            if (!conversationId) {

                return res.status(400).json({
                    error:
                        "Chat ID required hai."
                });
            }


            const conversation =
                await pool.query(
                    `
                    SELECT
                        id,
                        title
                    FROM chat_conversations
                    WHERE id = $1
                    AND user_id = $2
                    `,
                    [
                        conversationId,
                        req.user.id
                    ]
                );


            if (
                conversation.rows.length === 0
            ) {

                return res.status(404).json({
                    error:
                        "Chat nahi mili."
                });
            }


            const messages =
                await pool.query(
                    `
                    SELECT
                        id,
                        role,
                        content,
                        created_at
                    FROM chat_messages
                    WHERE conversation_id = $1
                    AND user_id = $2
                    ORDER BY
                        created_at ASC,
                        id ASC
                    `,
                    [
                        conversationId,
                        req.user.id
                    ]
                );


            return res.json({

                success: true,

                conversation: {

                    id:
                        conversation.rows[0].id,

                    title:
                        conversation.rows[0].title
                },

                messages:
                    messages.rows.map(
                        message => ({

                            id:
                                message.id,

                            role:
                                message.role,

                            content:
                                message.content,

                            createdAt:
                                message.created_at
                        })
                    )
            });


        } catch (error) {

            console.error(
                "CHAT HISTORY ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "Chat history load nahi ho paayi."
            });
        }
    }
);


// ============================================================
// DELETE CONVERSATION
// ============================================================

app.delete(
    "/api/conversations/:id",
    requireAuth,
    async (req, res) => {

        try {

            const conversationId =
                Number(
                    req.params.id
                );


            if (!conversationId) {

                return res.status(400).json({
                    error:
                        "Invalid chat ID."
                });
            }


            const result =
                await pool.query(
                    `
                    DELETE FROM
                        chat_conversations
                    WHERE id = $1
                    AND user_id = $2
                    RETURNING id
                    `,
                    [
                        conversationId,
                        req.user.id
                    ]
                );


            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    error:
                        "Chat nahi mili."
                });
            }


            return res.json({

                success: true,

                message:
                    "Chat deleted successfully."
            });


        } catch (error) {

            console.error(
                "DELETE CONVERSATION ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "Chat delete nahi ho paayi."
            });
        }
    }
);


// ============================================================
// RENAME CONVERSATION
// ============================================================

app.patch(
    "/api/conversations/:id",
    requireAuth,
    async (req, res) => {

        try {

            const conversationId =
                Number(
                    req.params.id
                );


            const title =
                typeof req.body.title ===
                "string"
                    ? req.body.title
                        .trim()
                        .slice(0, 200)
                    : "";


            if (!conversationId) {

                return res.status(400).json({
                    error:
                        "Invalid chat ID."
                });
            }


            if (!title) {

                return res.status(400).json({
                    error:
                        "Chat title required hai."
                });
            }


            const result =
                await pool.query(
                    `
                    UPDATE
                        chat_conversations
                    SET
                        title = $1,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $2
                    AND user_id = $3
                    RETURNING
                        id,
                        title,
                        created_at,
                        updated_at
                    `,
                    [
                        title,
                        conversationId,
                        req.user.id
                    ]
                );


            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    error:
                        "Chat nahi mili."
                });
            }


            const conversation =
                result.rows[0];


            return res.json({

                success: true,

                conversation: {

                    id:
                        conversation.id,

                    title:
                        conversation.title,

                    createdAt:
                        conversation.created_at,

                    updatedAt:
                        conversation.updated_at
                }
            });


        } catch (error) {

            console.error(
                "RENAME CONVERSATION ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "Chat rename nahi ho paayi."
            });
        }
    }
);


// ============================================================
// SAVE CHAT MESSAGE
// ============================================================

app.post(
    "/api/chat-history",
    requireAuth,
    async (req, res) => {

        try {

            const conversationId =
                Number(
                    req.body.chatId
                );


            const role =
                typeof req.body.role ===
                "string"
                    ? req.body.role.trim()
                    : "";


            const content =
                typeof req.body.content ===
                "string"
                    ? req.body.content
                    : "";


            if (!conversationId) {

                return res.status(400).json({
                    error:
                        "Chat ID required hai."
                });
            }


            if (
                !["user", "assistant"].includes(
                    role
                )
            ) {

                return res.status(400).json({
                    error:
                        "Invalid message role."
                });
            }


            if (!content.trim()) {

                return res.status(400).json({
                    error:
                        "Message empty nahi ho sakta."
                });
            }


            const conversation =
                await pool.query(
                    `
                    SELECT id
                    FROM chat_conversations
                    WHERE id = $1
                    AND user_id = $2
                    `,
                    [
                        conversationId,
                        req.user.id
                    ]
                );


            if (
                conversation.rows.length === 0
            ) {

                return res.status(404).json({
                    error:
                        "Chat nahi mili."
                });
            }


            const result =
                await pool.query(
                    `
                    INSERT INTO
                        chat_messages
                        (
                            user_id,
                            conversation_id,
                            role,
                            content
                        )
                    VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4
                        )
                    RETURNING
                        id,
                        role,
                        content,
                        created_at
                    `,
                    [
                        req.user.id,
                        conversationId,
                        role,
                        content
                    ]
                );


            await pool.query(
                `
                UPDATE
                    chat_conversations
                SET
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                AND user_id = $2
                `,
                [
                    conversationId,
                    req.user.id
                ]
            );


            return res.status(201).json({

                success: true,

                message:
                    result.rows[0]
            });


        } catch (error) {

            console.error(
                "SAVE CHAT HISTORY ERROR:",
                error
            );


            return res.status(500).json({
                error:
                    "Message save nahi ho paaya."
            });
        }
    }
);
// ===============================
// NORMAL AI CHAT
// ===============================

app.post(
    "/api/chat",
    requireAuth,
    async (req, res) => {

        try {

            const messages =
                req.body.messages || [];

            const conversationId =
                Number(
                    req.body.chatId
                );

            // -------------------------------
            // BASIC VALIDATION
            // -------------------------------

            if (!Array.isArray(messages)) {

                return res.status(400).json({
                    error:
                        "Invalid messages format."
                });

            }

            if (messages.length === 0) {

                return res.status(400).json({
                    error:
                        "Message required hai."
                });

            }

            if (!conversationId) {

                return res.status(400).json({
                    error:
                        "Chat ID required hai."
                });

            }

            // -------------------------------
            // CHECK CHAT OWNERSHIP
            // -------------------------------

            const conversation =
                await pool.query(`
                    SELECT
                        id,
                        title
                    FROM chat_conversations
                    WHERE id = $1
                    AND user_id = $2
                `, [
                    conversationId,
                    req.user.id
                ]);

            if (
                conversation.rows.length === 0
            ) {

                return res.status(404).json({
                    error:
                        "Chat nahi mili."
                });

            }

            // -------------------------------
            // CLEAN MESSAGES
            // -------------------------------

            const cleanMessages =
                messages
                    .filter(
                        msg =>
                            msg &&
                            (msg.role === "user" ||
                             msg.role === "assistant") &&
                            typeof msg.content === "string" &&
                            msg.content.trim()
                    )
                    .slice(-50)
                    .map(msg => ({
                        role: msg.role,
                        content: msg.content.trim()
                    }));

            if (cleanMessages.length === 0) {

                return res.status(400).json({
                    error:
                        "Valid message required hai."
                });

            }

            // -------------------------------
            // OPENAI RESPONSE
            // -------------------------------

            const response =
                await client.responses.create({

                    model:
                        "gpt-5.6-luna",

                    instructions:
                        "You are JAXX AI. " +
                        "Answer naturally, helpfully, and clearly. " +
                        "Communicate in Hindi, Hinglish, or English " +
                        "depending on the user's language. " +
                        "If someone asks who created you, who made you, " +
                        "who developed you, or Tumhe kisne banaya, " +
                        "answer clearly: Mujhe Ansh ne banaya hai. 😎 " +
                        "OpenAI provides the AI technology/API that powers you, " +
                        "but JAXX AI itself is a project created by Ansh.",

                    input:
                        cleanMessages

                });

            const reply =
                response.output_text || "";

            // -------------------------------
            // FIND LAST USER MESSAGE
            // -------------------------------

            const lastUserMessage =
                [...cleanMessages]
                    .reverse()
                    .find(
                        msg =>
                            msg.role === "user"
                    );

            // -------------------------------
            // SAVE USER MESSAGE
            // -------------------------------

            if (
                lastUserMessage &&
                lastUserMessage.content
            ) {

                await pool.query(`
                    INSERT INTO chat_messages
                        (
                            user_id,
                            conversation_id,
                            role,
                            content
                        )
                    VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4
                        )
                `, [
                    req.user.id,
                    conversationId,
                    "user",
                    lastUserMessage.content
                ]);

                // -------------------------------
                // AUTO CHAT TITLE
                // -------------------------------

                const currentTitle =
                    conversation.rows[0].title;

                if (
                    currentTitle === "New Chat"
                ) {

                    let title =
                        lastUserMessage.content
                            .replace(
                                /\s+/g,
                                " "
                            )
                            .trim();

                    if (
                        title.length > 40
                    ) {

                        title =
                            title.slice(
                                0,
                                40
                            ) + "...";

                    }

                    if (title) {

                        await pool.query(`
                            UPDATE chat_conversations
                            SET
                                title = $1,
                                updated_at =
                                    CURRENT_TIMESTAMP
                            WHERE id = $2
                            AND user_id = $3
                        `, [
                            title,
                            conversationId,
                            req.user.id
                        ]);

                    }

                }

            }

            // -------------------------------
            // SAVE AI REPLY
            // -------------------------------

            if (
                typeof reply === "string" &&
                reply.trim()
            ) {

                await pool.query(`
                    INSERT INTO chat_messages
                        (
                            user_id,
                            conversation_id,
                            role,
                            content
                        )
                    VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4
                        )
                `, [
                    req.user.id,
                    conversationId,
                    "assistant",
                    reply.trim()
                ]);

            }

            // -------------------------------
            // UPDATE CHAT TIME
            // -------------------------------

            await pool.query(`
                UPDATE chat_conversations
                SET
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                AND user_id = $2
            `, [
                conversationId,
                req.user.id
            ]);

            // -------------------------------
            // SEND RESPONSE
            // -------------------------------

            return res.json({
                reply: reply
            });

        } catch (error) {

            console.error(
                "CHAT ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "AI response nahi aa paaya. Server ya API configuration check karo."
            });

        }

    }
);


// ===============================
// IMAGE GENERATION
// FREE: 3 IMAGES / 48 HOURS
// PRO / PRO+: UNLIMITED
// ===============================

app.post(
    "/api/generate-image",
    requireAuth,
    async (req, res) => {

        let reservationId = null;

        try {

            // -------------------------------
            // GET FRESH USER
            // -------------------------------

            const user =
                await getFreshUser(
                    req.user.id
                );

            if (!user) {

                return res.status(401).json({
                    error:
                        "User account nahi mila."
                });

            }

            // -------------------------------
            // PROMPT VALIDATION
            // -------------------------------

            const prompt =
                typeof req.body.prompt === "string"
                    ? req.body.prompt.trim()
                    : "";

            if (!prompt) {

                return res.status(400).json({
                    error:
                        "Image prompt required hai."
                });

            }

            if (
                prompt.length > 4000
            ) {

                return res.status(400).json({
                    error:
                        "Image prompt bahut long hai."
                });

            }

            // -------------------------------
            // FREE PLAN LIMIT
            // 3 IMAGES / 48 HOURS
            // -------------------------------

            if (
                user.plan === "free"
            ) {

                const usage =
                    await reserveFreeImageGeneration(
                        user.id
                    );

                if (
                    !usage.allowed
                ) {

                    return res.status(429).json({

                        error:
                            "Free plan ki 3 AI image limit complete ho gayi hai. 48 hours ke window ke baad slot available hoga, ya Pro/Pro+ par upgrade kar sakte ho.",

                        code:
                            "IMAGE_LIMIT_REACHED",

                        used:
                            usage.used,

                        limit:
                            FREE_IMAGE_LIMIT,

                        windowHours:
                            FREE_IMAGE_WINDOW_HOURS

                    });

                }

                reservationId =
                    usage.reservationId;

            }

            // -------------------------------
            // GENERATE IMAGE
            // -------------------------------

            const result =
                await client.images.generate({

                    model:
                        "gpt-image-2",

                    prompt:
                        prompt,

                    size:
                        "1024x1024",

                    quality:
                        "medium"

                });

            const imageData =
                result?.data?.[0]?.b64_json;

            // -------------------------------
            // CHECK RESULT
            // -------------------------------

            if (!imageData) {

                if (
                    user.plan === "free" &&
                    reservationId
                ) {

                    await releaseFreeImageReservation(
                        reservationId
                    );

                    reservationId =
                        null;

                }

                console.error(
                    "IMAGE GENERATION RESPONSE:",
                    result
                );

                return res.status(500).json({
                    error:
                        "Image generate nahi ho paayi."
                });

            }

            // -------------------------------
            // GENERATION SUCCESS
            // Reservation consumed
            // -------------------------------

            reservationId =
                null;

            // -------------------------------
            // SAVE GENERATED IMAGE TO CHAT
            // -------------------------------

            const conversationId =
                Number(
                    req.body.chatId
                );

            if (conversationId) {

                const conversation =
                    await pool.query(`
                        SELECT
                            id
                        FROM chat_conversations
                        WHERE id = $1
                        AND user_id = $2
                    `, [
                        conversationId,
                        req.user.id
                    ]);

                if (
                    conversation.rows.length > 0
                ) {

                    await pool.query(`
                        INSERT INTO chat_messages
                            (
                                user_id,
                                conversation_id,
                                role,
                                content
                            )
                        VALUES
                            (
                                $1,
                                $2,
                                $3,
                                $4
                            )
                    `, [
                        req.user.id,
                        conversationId,
                        "assistant",
                        "[Generated image]"
                    ]);

                    await pool.query(`
                        UPDATE chat_conversations
                        SET
                            updated_at =
                                CURRENT_TIMESTAMP
                        WHERE id = $1
                        AND user_id = $2
                    `, [
                        conversationId,
                        req.user.id
                    ]);

                }

            }

            // -------------------------------
            // RETURN IMAGE
            // -------------------------------

            return res.json({

                success:
                    true,

                image:
                    `data:image/png;base64,${imageData}`

            });

        } catch (error) {

            // -------------------------------
            // RELEASE FREE SLOT
            // IF GENERATION FAILED
            // -------------------------------

            if (
                reservationId
            ) {

                try {

                    await releaseFreeImageReservation(
                        reservationId
                    );

                } catch (releaseError) {

                    console.error(
                        "IMAGE RESERVATION RELEASE ERROR:",
                        releaseError
                    );

                }

                reservationId =
                    null;

            }

            console.error(
                "IMAGE GENERATION ERROR:",
                error
            );

            return res.status(500).json({

                error:
                    error?.message ||
                    "Image generate nahi ho paayi."

            });

        }

    }
);


// ===============================
// UPLOAD CONFIG
// ===============================

const uploadDir =
    path.join(
        __dirname,
        "uploads"
    );

if (
    !fs.existsSync(
        uploadDir
    )
) {

    fs.mkdirSync(
        uploadDir,
        {
            recursive: true
        }
    );

}

const upload =
    multer({

        dest:
            uploadDir,

        limits: {

            fileSize:
                20 * 1024 * 1024

        }

    });


// ===============================
// FILE / IMAGE UPLOAD
// PREMIUM ONLY
// ===============================

app.post(
    "/api/upload",
    requireAuth,
    requirePlan([
        "pro",
        "pro_plus"
    ]),
    upload.single("file"),

    async (req, res) => {

        try {

            // -------------------------------
            // FILE CHECK
            // -------------------------------

            if (!req.file) {

                return res.status(400).json({
                    error:
                        "File select nahi ki gayi."
                });

            }

            // -------------------------------
            // CHAT ID
            // -------------------------------

            const conversationId =
                Number(
                    req.body.chatId
                );

            if (!conversationId) {

                return res.status(400).json({
                    error:
                        "Chat ID required hai."
                });

            }

            // -------------------------------
            // CHECK CHAT OWNERSHIP
            // -------------------------------

            const conversation =
                await pool.query(`
                    SELECT
                        id
                    FROM chat_conversations
                    WHERE id = $1
                    AND user_id = $2
                `, [
                    conversationId,
                    req.user.id
                ]);

            if (
                conversation.rows.length === 0
            ) {

                return res.status(404).json({
                    error:
                        "Chat nahi mili."
                });

            }

            // -------------------------------
            // USER MESSAGE
            // -------------------------------

            const userMessage =
                typeof req.body.message === "string" &&
                req.body.message.trim()
                    ? req.body.message.trim()
                    : "Is file ko analyze karo aur mujhe clearly explain karo.";

            // -------------------------------
            // FILE EXTENSION
            // -------------------------------

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

            // -------------------------------
            // READ FILE
            // -------------------------------

            const fileBuffer =
                fs.readFileSync(
                    req.file.path
                );

            // -------------------------------
            // CONVERT TO OPENAI FILE
            // -------------------------------

            const openAIFile =
                await toFile(
                    fileBuffer,
                    req.file.originalname,
                    {
                        type:
                            req.file.mimetype
                    }
                );

            // -------------------------------
            // UPLOAD TO OPENAI
            // -------------------------------

            const uploadedFile =
                await client.files.create({

                    file:
                        openAIFile,

                    purpose:
                        isImage
                            ? "vision"
                            : "user_data"

                });

            let reply = "";

            // ==================================================
            // IMAGE ANALYSIS
            // ==================================================

            if (isImage) {

                const response =
                    await client.responses.create({

                        model:
                            "gpt-5.6-luna",

                        instructions:
                            "You are JAXX AI. " +
                            "Analyze the uploaded image carefully. " +
                            "Describe and explain what is visible accurately. " +
                            "Answer naturally in Hindi, Hinglish, or English " +
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
                                            "input_image",

                                        image_url:
                                            `data:${req.file.mimetype};base64,${fileBuffer.toString("base64")}`

                                    }

                                ]

                            }

                        ]

                    });

                reply =
                    response.output_text || "";

            }

            // ==================================================
            // NORMAL FILE ANALYSIS
            // ==================================================

            else {

                const response =
                    await client.responses.create({

                        model:
                            "gpt-5.6-luna",

                        instructions:
                            "You are JAXX AI. " +
                            "Analyze the uploaded file carefully. " +
                            "Extract and understand useful information from it. " +
                            "Answer clearly and naturally in Hindi, Hinglish, " +
                            "or English depending on the user's language.",

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

                reply =
                    response.output_text || "";

            }

            // -------------------------------
            // SAVE USER FILE MESSAGE
            // -------------------------------

            await pool.query(`
                INSERT INTO chat_messages
                    (
                        user_id,
                        conversation_id,
                        role,
                        content
                    )
                VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4
                    )
            `, [
                req.user.id,
                conversationId,
                "user",
                userMessage
            ]);

            // -------------------------------
            // SAVE AI RESPONSE
            // -------------------------------

            const historyReply =
                `[File: ${req.file.originalname}]\n\n${reply}`;

            await pool.query(`
                INSERT INTO chat_messages
                    (
                        user_id,
                        conversation_id,
                        role,
                        content
                    )
                VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4
                    )
            `, [
                req.user.id,
                conversationId,
                "assistant",
                historyReply
            ]);

            // -------------------------------
            // UPDATE CHAT
            // -------------------------------

            await pool.query(`
                UPDATE chat_conversations
                SET
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                AND user_id = $2
            `, [
                conversationId,
                req.user.id
            ]);

            // -------------------------------
            // RESPONSE
            // -------------------------------

            return res.json({

                success:
                    true,

                reply:
                    reply,

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

            return res.status(500).json({

                error:
                    error?.message ||
                    "File analyze nahi ho paayi."

            });

        } finally {

            // -------------------------------
            // DELETE TEMPORARY FILE
            // -------------------------------

            if (req.file) {

                try {

                    fs.unlinkSync(
                        req.file.path
                    );

                } catch (cleanupError) {

                    console.error(
                        "TEMP FILE CLEANUP ERROR:",
                        cleanupError
                    );

                }

            }

        }

    }
);
// ===============================
// STATIC FILES + START SERVER
// ===============================

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function startServer() {
    try {
        await initDatabase();

        app.listen(PORT, "0.0.0.0", () => {
            console.log(`🚀 JAXX AI running on http://localhost:${PORT}`);
        });

    } catch (error) {
        console.error("❌ SERVER START ERROR:", error);
        process.exit(1);
    }
}

startServer();