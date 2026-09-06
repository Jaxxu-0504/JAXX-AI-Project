const express = require("express");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
require("dotenv").config();

const OpenAI = require("openai");
const { toFile } = require("openai");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// OPENAI
// ===============================

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ===============================
// STRIPE
// ===============================

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

// ===============================
// POSTGRESQL
// ===============================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
});

// ===============================
// PLAN CONFIG
// ===============================

const PLANS = {
    free: {
        id: "free",
        name: "Free",
        price: 0,
        video: false,
        upload: false
    },

    pro: {
        id: "pro",
        name: "Pro",
        price: 199,
        video: true,
        upload: true
    },

    pro_plus: {
        id: "pro_plus",
        name: "Pro+",
        price: 399,
        video: true,
        upload: true
    }
};

// ===============================
// DATABASE INITIALIZATION
// ===============================

async function initDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            plan VARCHAR(20) NOT NULL DEFAULT 'free',
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Existing databases migration
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_conversations (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,
            title VARCHAR(200) NOT NULL DEFAULT 'New Chat',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,
            role VARCHAR(20) NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        ALTER TABLE chat_messages
        ADD COLUMN IF NOT EXISTS conversation_id INTEGER
        REFERENCES chat_conversations(id)
        ON DELETE CASCADE
    `);

    const oldUsers = await pool.query(`
        SELECT DISTINCT user_id
        FROM chat_messages
        WHERE conversation_id IS NULL
    `);

    for (const row of oldUsers.rows) {

        const conversationResult = await pool.query(`
            INSERT INTO chat_conversations
                (user_id, title)
            VALUES
                ($1, $2)
            RETURNING id
        `, [
            row.user_id,
            "Previous Chats"
        ]);

        const conversationId =
            conversationResult.rows[0].id;

        await pool.query(`
            UPDATE chat_messages
            SET conversation_id = $1
            WHERE user_id = $2
            AND conversation_id IS NULL
        `, [
            conversationId,
            row.user_id
        ]);
    }

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_chat_conversations_user
        ON chat_conversations(user_id)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_chat_messages_conversation
        ON chat_messages(conversation_id)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_chat_messages_user
        ON chat_messages(user_id)
    `);

    console.log("✅ PostgreSQL database ready");
    console.log("✅ Users table ready");
    console.log("✅ Conversations table ready");
    console.log("✅ Chat messages table ready");
    console.log("✅ Stripe fields ready");
}

// ===============================
// STRIPE WEBHOOK
// IMPORTANT:
// This MUST come before express.json()
// ===============================

app.post(
    "/api/stripe-webhook",
    express.raw({
        type: "application/json"
    }),
    async (req, res) => {

        if (!stripe) {

            console.error(
                "STRIPE WEBHOOK: Stripe is not configured."
            );

            return res.status(500).send(
                "Stripe not configured."
            );
        }

        const signature =
            req.headers["stripe-signature"];

        if (!signature) {

            return res.status(400).send(
                "Missing Stripe signature."
            );
        }

        let event;

        try {

            event =
                stripe.webhooks.constructEvent(
                    req.body,
                    signature,
                    process.env.STRIPE_WEBHOOK_SECRET
                );

        } catch (error) {

            console.error(
                "STRIPE WEBHOOK SIGNATURE ERROR:",
                error.message
            );

            return res.status(400).send(
                `Webhook Error: ${error.message}`
            );
        }

        try {

            console.log(
                "💳 STRIPE EVENT:",
                event.type
            );

            // ===============================
            // CHECKOUT COMPLETED
            // ===============================

            if (
                event.type ===
                "checkout.session.completed"
            ) {

                const session =
                    event.data.object;

                const userId =
                    Number(
                        session.client_reference_id
                    );

                const plan =
                    session.metadata?.plan;

                const subscriptionId =
                    typeof session.subscription === "string"
                        ? session.subscription
                        : session.subscription?.id || null;

                const customerId =
                    typeof session.customer === "string"
                        ? session.customer
                        : session.customer?.id || null;

                if (
                    !userId ||
                    !["pro", "pro_plus"].includes(plan)
                ) {

                    console.error(
                        "Invalid checkout session data:",
                        {
                            userId,
                            plan
                        }
                    );

                    return res.json({
                        received: true
                    });
                }

                await pool.query(`
                    UPDATE users
                    SET
                        plan = $1,
                        stripe_customer_id = $2,
                        stripe_subscription_id = $3
                    WHERE id = $4
                `, [
                    plan,
                    customerId,
                    subscriptionId,
                    userId
                ]);

                console.log(
                    `✅ USER ${userId} upgraded to ${plan}`
                );
            }

            // ===============================
            // SUBSCRIPTION UPDATED
            // ===============================

            if (
                event.type ===
                "customer.subscription.updated"
            ) {

                const subscription =
                    event.data.object;

                const subscriptionId =
                    subscription.id;

                const userResult =
                    await pool.query(`
                        SELECT id
                        FROM users
                        WHERE stripe_subscription_id = $1
                    `, [
                        subscriptionId
                    ]);

                if (
                    userResult.rows.length > 0
                ) {

                    const userId =
                        userResult.rows[0].id;

                    const status =
                        subscription.status;

                    if (
                        status === "active" ||
                        status === "trialing"
                    ) {

                        console.log(
                            `✅ Subscription active for user ${userId}`
                        );

                    } else {

                        await pool.query(`
                            UPDATE users
                            SET
                                plan = 'free'
                            WHERE id = $1
                        `, [
                            userId
                        ]);

                        console.log(
                            `⬇️ User ${userId} moved to free`
                        );
                    }
                }
            }

            // ===============================
            // SUBSCRIPTION DELETED
            // ===============================

            if (
                event.type ===
                "customer.subscription.deleted"
            ) {

                const subscription =
                    event.data.object;

                await pool.query(`
                    UPDATE users
                    SET
                        plan = 'free',
                        stripe_subscription_id = NULL
                    WHERE stripe_subscription_id = $1
                `, [
                    subscription.id
                ]);

                console.log(
                    "⬇️ Subscription cancelled -> Free plan"
                );
            }

            return res.json({
                received: true
            });

        } catch (error) {

            console.error(
                "STRIPE WEBHOOK PROCESSING ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "Webhook processing failed."
            });
        }
    }
);

// ===============================
// MIDDLEWARE
// ===============================

app.use(
    express.json({
        limit: "20mb"
    })
);

app.use(cookieParser());

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

// ===============================
// AUTH
// ===============================

function createToken(user) {

    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            plan: user.plan
        },
        process.env.JWT_SECRET,
        {
            expiresIn: "7d"
        }
    );
}

function getUserFromToken(req) {

    const token =
        req.cookies.jaxx_token;

    if (!token) {
        return null;
    }

    try {

        return jwt.verify(
            token,
            process.env.JWT_SECRET
        );

    } catch {

        return null;
    }
}

function requireAuth(req, res, next) {

    const user =
        getUserFromToken(req);

    if (!user) {

        return res.status(401).json({
            error: "Login required hai."
        });
    }

    req.user = user;

    next();
}

// ===============================
// FRESH USER
// ===============================

async function getFreshUser(userId) {

    const result = await pool.query(`
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
    `, [userId]);

    if (result.rows.length === 0) {
        return null;
    }

    return result.rows[0];
}

// ===============================
// PREMIUM PLAN CHECK
// ===============================

function requirePlan(requiredPlans) {

    return async (req, res, next) => {

        try {

            const user =
                await getFreshUser(req.user.id);

            if (!user) {

                return res.status(401).json({
                    error:
                        "User account nahi mila."
                });
            }

            req.dbUser = user;

            if (
                !requiredPlans.includes(
                    user.plan
                )
            ) {

                return res.status(403).json({

                    error:
                        "Ye feature premium plan me available hai.",

                    code:
                        "PREMIUM_REQUIRED",

                    currentPlan:
                        user.plan,

                    requiredPlans:
                        requiredPlans
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
                    "Plan verify nahi ho paaya."
            });
        }
    };
}

// ===============================
// PLANS API
// ===============================

app.get(
    "/api/plans",
    (req, res) => {

        return res.json({
            success: true,
            plans: PLANS
        });
    }
);

// ===============================
// CREATE STRIPE CHECKOUT
// ===============================

app.post(
    "/api/create-checkout-session",
    requireAuth,
    async (req, res) => {

        try {

            if (!stripe) {

                return res.status(500).json({
                    error:
                        "Stripe configured nahi hai. STRIPE_SECRET_KEY .env me add karo."
                });
            }

            const plan =
                typeof req.body.plan === "string"
                    ? req.body.plan.trim()
                    : "";

            if (
                !["pro", "pro_plus"].includes(plan)
            ) {

                return res.status(400).json({
                    error:
                        "Invalid premium plan."
                });
            }

            const priceId =
                plan === "pro"
                    ? process.env.STRIPE_PRO_PRICE_ID
                    : process.env.STRIPE_PRO_PLUS_PRICE_ID;

            if (!priceId) {

                return res.status(500).json({
                    error:
                        `${plan} ka Stripe Price ID configured nahi hai.`
                });
            }

            const user =
                await getFreshUser(
                    req.user.id
                );

            if (!user) {

                return res.status(404).json({
                    error:
                        "User account nahi mila."
                });
            }

            // Already on same plan
            if (user.plan === plan) {

                return res.status(400).json({
                    error:
                        `Aap already ${PLANS[plan].name} plan par ho.`
                });
            }

            // ===============================
            // CREATE / REUSE STRIPE CUSTOMER
            // ===============================

            let customerId =
                user.stripe_customer_id;

            if (!customerId) {

                const customer =
                    await stripe.customers.create({

                        name:
                            user.name,

                        email:
                            user.email,

                        metadata: {
                            jaxx_user_id:
                                String(user.id)
                        }
                    });

                customerId =
                    customer.id;

                await pool.query(`
                    UPDATE users
                    SET
                        stripe_customer_id = $1
                    WHERE id = $2
                `, [
                    customerId,
                    user.id
                ]);
            }

            // ===============================
            // CHECKOUT SESSION
            // ===============================

            const baseUrl =
                process.env.APP_URL ||
                `http://localhost:${PORT}`;

            const session =
                await stripe.checkout.sessions.create({

                    mode:
                        "subscription",

                    customer:
                        customerId,

                    line_items: [
                        {
                            price:
                                priceId,

                            quantity:
                                1
                        }
                    ],

                    client_reference_id:
                        String(user.id),

                    metadata: {

                        user_id:
                            String(user.id),

                        plan:
                            plan
                    },

                    subscription_data: {

                        metadata: {

                            user_id:
                                String(user.id),

                            plan:
                                plan
                        }
                    },

                    success_url:
                        `${baseUrl}/?payment=success&plan=${plan}`,

                    cancel_url:
                        `${baseUrl}/?payment=cancelled`,

                    allow_promotion_codes:
                        true
                });

            return res.json({

                success: true,

                url:
                    session.url

            });

        } catch (error) {

            console.error(
                "CREATE CHECKOUT ERROR:",
                error
            );

            return res.status(500).json({

                error:
                    error?.message ||
                    "Stripe checkout create nahi ho paaya."
            });
        }
    }
);

// ===============================
// CREATE STRIPE CUSTOMER PORTAL
// ===============================

app.post(
    "/api/create-customer-portal",
    requireAuth,
    async (req, res) => {

        try {

            if (!stripe) {

                return res.status(500).json({
                    error:
                        "Stripe configured nahi hai."
                });
            }

            const user =
                await getFreshUser(
                    req.user.id
                );

            if (!user) {

                return res.status(404).json({
                    error:
                        "User account nahi mila."
                });
            }

            if (!user.stripe_customer_id) {

                return res.status(400).json({
                    error:
                        "Stripe customer abhi create nahi hua."
                });
            }

            const baseUrl =
                process.env.APP_URL ||
                `http://localhost:${PORT}`;

            const portalSession =
                await stripe.billingPortal.sessions.create({

                    customer:
                        user.stripe_customer_id,

                    return_url:
                        baseUrl
                });

            return res.json({

                success: true,

                url:
                    portalSession.url

            });

        } catch (error) {

            console.error(
                "CUSTOMER PORTAL ERROR:",
                error
            );

            return res.status(500).json({

                error:
                    error?.message ||
                    "Customer portal create nahi ho paaya."
            });
        }
    }
);

// ===============================
// SIGNUP
// ===============================

app.post(
    "/api/signup",
    async (req, res) => {

        try {

            const name =
                typeof req.body.name === "string"
                    ? req.body.name.trim()
                    : "";

            const email =
                typeof req.body.email === "string"
                    ? req.body.email
                        .trim()
                        .toLowerCase()
                    : "";

            const password =
                typeof req.body.password === "string"
                    ? req.body.password
                    : "";

            if (!name) {

                return res.status(400).json({
                    error:
                        "Name required hai."
                });
            }

            if (name.length > 100) {

                return res.status(400).json({
                    error:
                        "Name bahut long hai."
                });
            }

            if (
                !email ||
                !email.includes("@")
            ) {

                return res.status(400).json({
                    error:
                        "Valid email required hai."
                });
            }

            if (password.length < 8) {

                return res.status(400).json({
                    error:
                        "Password minimum 8 characters ka hona chahiye."
                });
            }

            const existingUser =
                await pool.query(`
                    SELECT id
                    FROM users
                    WHERE email = $1
                `, [email]);

            if (
                existingUser.rows.length > 0
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
                await pool.query(`
                    INSERT INTO users
                        (
                            name,
                            email,
                            password_hash
                        )
                    VALUES
                        (
                            $1,
                            $2,
                            $3
                        )
                    RETURNING
                        id,
                        name,
                        email,
                        plan,
                        created_at
                `, [
                    name,
                    email,
                    passwordHash
                ]);

            const user =
                result.rows[0];

            const token =
                createToken(user);

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

            return res.status(201).json({

                success: true,

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    plan: user.plan
                }
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

// ===============================
// LOGIN
// ===============================

app.post(
    "/api/login",
    async (req, res) => {

        try {

            const email =
                typeof req.body.email === "string"
                    ? req.body.email
                        .trim()
                        .toLowerCase()
                    : "";

            const password =
                typeof req.body.password === "string"
                    ? req.body.password
                    : "";

            if (
                !email ||
                !password
            ) {

                return res.status(400).json({
                    error:
                        "Email aur password required hai."
                });
            }

            const result =
                await pool.query(`
                    SELECT
                        id,
                        name,
                        email,
                        password_hash,
                        plan
                    FROM users
                    WHERE email = $1
                `, [email]);

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
                createToken(user);

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

            return res.json({

                success: true,

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    plan: user.plan
                }
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

// ===============================
// CURRENT USER
// ===============================

app.get(
    "/api/me",
    async (req, res) => {

        try {

            const tokenUser =
                getUserFromToken(req);

            if (!tokenUser) {

                return res.json({
                    loggedIn: false
                });
            }

            const user =
                await getFreshUser(
                    tokenUser.id
                );

            if (!user) {

                return res.json({
                    loggedIn: false
                });
            }

            return res.json({

                loggedIn: true,

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    plan: user.plan,
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

// ===============================
// LOGOUT
// ===============================

app.post(
    "/api/logout",
    (req, res) => {

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

        return res.json({
            success: true
        });
    }
);

// ===============================
// CONVERSATIONS
// ===============================

app.get(
    "/api/conversations",
    requireAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(`
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
                `, [req.user.id]);

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

// ===============================
// CREATE CONVERSATION
// ===============================

app.post(
    "/api/conversations",
    requireAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(`
                    INSERT INTO chat_conversations
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
                `, [
                    req.user.id,
                    "New Chat"
                ]);

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

// ===============================
// CHAT HISTORY
// ===============================

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
                await pool.query(`
                    SELECT id
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

            const result =
                await pool.query(`
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
                `, [
                    conversationId,
                    req.user.id
                ]);

            return res.json({

                success: true,

                messages:
                    result.rows.map(
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

// ===============================
// DELETE CONVERSATION
// ===============================

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
                await pool.query(`
                    DELETE FROM chat_conversations
                    WHERE id = $1
                    AND user_id = $2
                    RETURNING id
                `, [
                    conversationId,
                    req.user.id
                ]);

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    error:
                        "Chat nahi mili."
                });
            }

            return res.json({
                success: true
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

// ===============================
// RENAME CONVERSATION
// ===============================

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
                typeof req.body.title === "string"
                    ? req.body.title
                        .trim()
                        .slice(0, 200)
                    : "";

            if (
                !conversationId ||
                !title
            ) {

                return res.status(400).json({
                    error:
                        "Valid title required hai."
                });
            }

            const result =
                await pool.query(`
                    UPDATE chat_conversations
                    SET
                        title = $1,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $2
                    AND user_id = $3
                    RETURNING
                        id,
                        title,
                        updated_at
                `, [
                    title,
                    conversationId,
                    req.user.id
                ]);

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

                conversation:
                    result.rows[0]
            });

        } catch (error) {

            console.error(
                "UPDATE TITLE ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "Chat title update nahi ho paaya."
            });
        }
    }
);

// ===============================
// MANUAL SAVE MESSAGE
// ===============================

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
                typeof req.body.role === "string"
                    ? req.body.role.trim()
                    : "";

            const content =
                typeof req.body.content === "string"
                    ? req.body.content.trim()
                    : "";

            if (!conversationId) {

                return res.status(400).json({
                    error:
                        "Chat ID required hai."
                });
            }

            if (
                role !== "user" &&
                role !== "assistant"
            ) {

                return res.status(400).json({
                    error:
                        "Invalid message role."
                });
            }

            if (!content) {

                return res.status(400).json({
                    error:
                        "Message content required hai."
                });
            }

            const conversation =
                await pool.query(`
                    SELECT id
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

            const result =
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
                    RETURNING
                        id,
                        role,
                        content,
                        created_at
                `, [
                    req.user.id,
                    conversationId,
                    role,
                    content
                ]);

            await pool.query(`
                UPDATE chat_conversations
                SET
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
            `, [conversationId]);

            const message =
                result.rows[0];

            return res.status(201).json({

                success: true,

                message: {

                    id:
                        message.id,

                    role:
                        message.role,

                    content:
                        message.content,

                    createdAt:
                        message.created_at
                }
            });

        } catch (error) {

            console.error(
                "SAVE CHAT ERROR:",
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

            if (
                !Array.isArray(messages)
            ) {

                return res.status(400).json({
                    error:
                        "Invalid messages format."
                });
            }

            if (
                messages.length === 0
            ) {

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

            const response =
                await client.responses.create({

                    model:
                        "gpt-5.6-luna",

                    instructions:
                        "You are JAXX AI, a helpful, friendly and intelligent AI assistant. " +
                        "Use emojis naturally in your responses when appropriate. " +
                        "Do not overuse emojis. " +
                        "You were created and developed by Ansh. " +
                        "If someone asks who created you, who made you, who developed you, " +
                        "or Tumhe kisne banaya, answer clearly: Mujhe Ansh ne banaya hai. 😎 " +
                        "OpenAI provides the AI technology/API that powers you, but JAXX AI itself " +
                        "is a project created by Ansh. " +
                        "Communicate naturally in Hindi, Hinglish, or English depending on the user's language.",

                    input:
                        messages.map(
                            msg => ({

                                role:
                                    msg.role,

                                content:
                                    msg.content
                            })
                        )
                });

            const reply =
                response.output_text;

            const lastUserMessage =
                [...messages]
                    .reverse()
                    .find(
                        msg =>
                            msg.role === "user"
                    );

            if (
                lastUserMessage &&
                typeof lastUserMessage.content ===
                    "string" &&
                lastUserMessage.content.trim()
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
                    lastUserMessage.content.trim()
                ]);

                const currentTitle =
                    conversation.rows[0].title;

                if (
                    currentTitle ===
                    "New Chat"
                ) {

                    let title =
                        lastUserMessage.content
                            .trim()
                            .replace(
                                /\s+/g,
                                " "
                            );

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
// UPLOAD CONFIG
// ===============================

const uploadDir =
    path.join(
        __dirname,
        "uploads"
    );

if (!fs.existsSync(uploadDir)) {

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

            if (!req.file) {

                return res.status(400).json({
                    error:
                        "File select nahi ki gayi."
                });
            }

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

            const conversation =
                await pool.query(`
                    SELECT id
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

            const userMessage =
                typeof req.body.message === "string" &&
                req.body.message.trim()
                    ? req.body.message.trim()
                    : "Is file ko analyze karo aur mujhe clearly explain karo.";

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

            let reply = "";

            if (isImage) {

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

                reply =
                    response.output_text;

            } else {

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

                reply =
                    response.output_text;
            }

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

            return res.json({

                success: true,

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

// ===============================
// VIDEO GENERATION
// PREMIUM ONLY
// ===============================

app.post(
    "/api/generate-video",
    requireAuth,
    requirePlan([
        "pro",
        "pro_plus"
    ]),
    async (req, res) => {

        try {

            if (
                !process.env.RUNWAYML_API_SECRET
            ) {

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
                    error:
                        "Video prompt required hai."
                });
            }

            let duration =
                Math.round(
                    Number(
                        req.body.duration
                    ) || 5
                );

            if (duration < 2) {
                duration = 2;
            }

            if (duration > 10) {
                duration = 10;
            }

            const ratio =
                req.body.ratio ===
                "720:1280"
                    ? "720:1280"
                    : "1280:720";

            if (prompt.length > 2000) {

                return res.status(400).json({
                    error:
                        "Video prompt bahut long hai."
                });
            }

            console.log(
                "--------------------------------"
            );

            console.log(
                "🎬 VIDEO GENERATION STARTED"
            );

            console.log(
                "Prompt:",
                prompt
            );

            console.log(
                "Duration:",
                duration
            );

            console.log(
                "Ratio:",
                ratio
            );

            console.log(
                "Plan:",
                req.dbUser.plan
            );

            console.log(
                "--------------------------------"
            );

            const createResponse =
                await fetch(
                    "https://api.dev.runwayml.com/v1/image_to_video",
                    {

                        method: "POST",

                        headers: {

                            Authorization:
                                `Bearer ${process.env.RUNWAYML_API_SECRET}`,

                            "Content-Type":
                                "application/json",

                            "X-Runway-Version":
                                "2024-11-06"
                        },

                        body:
                            JSON.stringify({

                                model:
                                    "gen4.5",

                                promptImage:
                                    "https://upload.wikimedia.org/wikipedia/commons/8/85/Tour_Eiffel_Wikimedia_Commons_(cropped).jpg",

                                promptText:
                                    prompt,

                                ratio:
                                    ratio,

                                duration:
                                    duration
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

            if (
                !createResponse.ok
            ) {

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

            let completedTask =
                null;

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

                                Authorization:
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

                if (
                    !taskResponse.ok
                ) {

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

            if (!completedTask) {

                return res.status(504).json({

                    error:
                        "Video generation timeout ho gayi. Runway ne 5 minutes me result nahi diya."
                });
            }

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
    }
);

// ===============================
// START SERVER
// ===============================

async function startServer() {

    try {

        await initDatabase();

        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `🚀 JAXX AI running on port ${PORT}`
                );

                if (stripe) {

                    console.log(
                        "💳 Stripe configured"
                    );

                } else {

                    console.log(
                        "⚠️ Stripe not configured yet"
                    );
                }
            }
        );

    } catch (error) {

        console.error(
            "❌ DATABASE ERROR:"
        );

        console.dir(
            error,
            {
                depth: null
            }
        );

        process.exit(1);
    }
}

startServer();