import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/reliefsync";

const reliefTypes = ["Food Packs", "Water", "Hygiene Kits", "Medicine Support", "Sleeping Mats"];
const defaultNeeds = Object.fromEntries(reliefTypes.map((item) => [item, 0]));

const DEFAULT_INVENTORY = [
  { item: "Food Packs", quantity: 320, unit: "packs" },
  { item: "Water", quantity: 600, unit: "bottles" },
  { item: "Hygiene Kits", quantity: 180, unit: "kits" },
  { item: "Medicine Support", quantity: 85, unit: "sets" },
  { item: "Sleeping Mats", quantity: 90, unit: "pieces" },
];

const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedPrototypeOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    const hostname = url.hostname;

    const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
    const isPrivateLan =
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

    return url.protocol === "http:" && (isLocalhost || isPrivateLan);
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedPrototypeOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

function normalizeNeeds(input) {
  const needs = { ...defaultNeeds };

  if (Array.isArray(input)) {
    input.forEach((item) => {
      if (reliefTypes.includes(item)) needs[item] = Math.max(needs[item], 1);
    });
    return needs;
  }

  if (input && typeof input === "object") {
    reliefTypes.forEach((item) => {
      needs[item] = Number(input[item] || 0);
    });
  }

  return needs;
}

function normalizeDistributionItems(body = {}) {
  if (Array.isArray(body.items)) {
    return body.items
      .filter((line) => line?.item && Number(line.quantity) > 0)
      .map((line) => ({ item: line.item, quantity: Number(line.quantity) }));
  }

  if (body.item) {
    return [{ item: body.item, quantity: Number(body.quantity || 1) }];
  }

  return [];
}

function computeDeprivationScore(record) {
  const damageScore = record.damageLevel === "Severe" ? 40 : record.damageLevel === "Moderate" ? 25 : 10;
  const vulnerabilityScore =
    Number(record.infants || 0) * 10 +
    Number(record.seniors || 0) * 10 +
    Number(record.pwd || 0) * 15 +
    Number(record.pregnant || 0) * 12;
  const householdScore = Number(record.members || 0) >= 6 ? 8 : Number(record.members || 0) >= 4 ? 5 : 2;
  const statusScore = record.status === "Pending" ? 5 : 0;
  return Math.min(100, damageScore + vulnerabilityScore + householdScore + statusScore);
}

const beneficiarySchema = new mongoose.Schema(
  {
    familyName: { type: String, default: "", trim: true },
    householdHead: { type: String, required: true, trim: true },
    barangay: { type: String, required: true, trim: true },
    purok: { type: String, default: "" },
    locationNote: { type: String, default: "" },
    pin: {
      x: { type: Number, default: null },
      y: { type: Number, default: null },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    members: { type: Number, default: 1, min: 1 },
    infants: { type: Number, default: 0, min: 0 },
    seniors: { type: Number, default: 0, min: 0 },
    pwd: { type: Number, default: 0, min: 0 },
    pregnant: { type: Number, default: 0, min: 0 },
    damageLevel: { type: String, enum: ["Minor", "Moderate", "Severe"], default: "Moderate" },
    reliefNeeds: { type: mongoose.Schema.Types.Mixed, default: defaultNeeds },
    contact: { type: String, default: "" },
    status: { type: String, enum: ["Pending", "Verified", "Rejected"], default: "Pending" },
    source: { type: String, default: "Resident Self-Profiling" },
    assignedPartner: { type: String, default: "CSWD" },
    deprivationScore: { type: Number, default: 0 },
    consentGiven: { type: Boolean, default: true },
    isOptedOut: { type: Boolean, default: false },
    optOutReason: { type: String, default: "" },
  },
  { timestamps: true }
);

beneficiarySchema.pre("save", function updateBeneficiary() {
  this.reliefNeeds = normalizeNeeds(this.reliefNeeds);
  this.deprivationScore = computeDeprivationScore(this);
});

const inventorySchema = new mongoose.Schema(
  {
    item: { type: String, required: true, trim: true, unique: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

const distributionSchema = new mongoose.Schema(
  {
    beneficiaryId: { type: mongoose.Schema.Types.ObjectId, ref: "Beneficiary", required: true },
    householdHead: { type: String, required: true },
    barangay: { type: String, required: true },
    items: [
      {
        item: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
      },
    ],
    agency: { type: String, default: "CSWD (City Social Welfare & Development)" },
    status: { type: String, enum: ["Scheduled", "Delivered"], default: "Scheduled" },
    encodedBy: { type: String, default: "CSWD" },
    item: { type: String, default: undefined },
    quantity: { type: Number, default: undefined },
  },
  { timestamps: true }
);

const Beneficiary = mongoose.model("Beneficiary", beneficiarySchema);
const Inventory = mongoose.model("Inventory", inventorySchema);
const Distribution = mongoose.model("Distribution", distributionSchema);

function cleanBeneficiary(doc) {
  const obj = doc.toObject ? doc.toObject() : doc;
  return {
    ...obj,
    id: obj._id,
    familyName: obj.familyName || "",
    reliefNeeds: normalizeNeeds(obj.reliefNeeds),
    isOptedOut: Boolean(obj.isOptedOut),
    consentGiven: obj.consentGiven !== undefined ? Boolean(obj.consentGiven) : true,
    optOutReason: obj.optOutReason || "",
  };
}

function cleanDistribution(doc) {
  const obj = doc.toObject ? doc.toObject() : doc;
  const items = Array.isArray(obj.items) && obj.items.length
    ? obj.items
    : obj.item
      ? [{ item: obj.item, quantity: Number(obj.quantity || 1) }]
      : [];
  return {
    ...obj,
    id: obj._id,
    items,
    agency: obj.agency || "CSWD (City Social Welfare & Development)",
  };
}

async function getProcessedReliefByBeneficiary(beneficiaryId, session = null) {
  const query = Distribution.find({ beneficiaryId });
  if (session) query.session(session);

  const existingDistributions = await query;
  const processedByItem = { ...defaultNeeds };

  existingDistributions.forEach((log) => {
    normalizeDistributionItems(log).forEach((line) => {
      processedByItem[line.item] = Number(processedByItem[line.item] || 0) + Number(line.quantity || 0);
    });
  });

  return processedByItem;
}

function combineRequestedItems(items) {
  const combined = { ...defaultNeeds };

  items.forEach((line) => {
    combined[line.item] = Number(combined[line.item] || 0) + Number(line.quantity || 0);
  });

  return combined;
}

function validateDistributionAgainstNeeds(beneficiary, items, processedByItem) {
  const neededByItem = normalizeNeeds(beneficiary.reliefNeeds);
  const requestedByItem = combineRequestedItems(items);

  for (const item of reliefTypes) {
    const requested = Number(requestedByItem[item] || 0);
    if (requested <= 0) continue;

    const needed = Number(neededByItem[item] || 0);
    const alreadyProcessed = Number(processedByItem[item] || 0);
    const remaining = Math.max(0, needed - alreadyProcessed);

    if (needed <= 0) {
      throw new Error(`${item} is not listed as a needed relief item for this resident.`);
    }

    if (remaining <= 0) {
      throw new Error(`${item} has already been fully processed for this resident.`);
    }

    if (requested > remaining) {
      throw new Error(`${item} request exceeds remaining need. Remaining: ${remaining}.`);
    }
  }

  const totalRemaining = reliefTypes.reduce((sum, item) => {
    return sum + Math.max(0, Number(neededByItem[item] || 0) - Number(processedByItem[item] || 0));
  }, 0);

  if (totalRemaining <= 0) {
    throw new Error("All relief needs for this resident have already been processed.");
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "ReliefSync API",
    database: mongoose.connection.readyState === 1 ? "connected" : "not connected",
  });
});

app.get("/api/beneficiaries", async (req, res) => {
  try {
    const beneficiaries = await Beneficiary.find().sort({ createdAt: -1 });
    res.json(beneficiaries.map(cleanBeneficiary));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/beneficiaries", async (req, res) => {
  try {
    const body = req.body || {};
    const contactDigits = String(body.contact || "").replace(/\D/g, "");
    const householdName = String(body.householdHead || "").trim();

    if (householdName && contactDigits) {
      const existingProfiles = await Beneficiary.find({
        householdHead: new RegExp(`^${householdName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      });

      const matchedProfile = existingProfiles.find(
        (record) => String(record.contact || "").replace(/\D/g, "") === contactDigits
      );

      if (matchedProfile) {
        return res.status(409).json({
          message: "Existing resident profile found. Please update the existing profile instead of creating a duplicate.",
          existing: cleanBeneficiary(matchedProfile),
        });
      }
    }

    const beneficiary = await Beneficiary.create({
      ...body,
      reliefNeeds: normalizeNeeds(body.reliefNeeds),
      isOptedOut: Boolean(body.isOptedOut),
      consentGiven: body.consentGiven !== undefined ? Boolean(body.consentGiven) : true,
    });
    res.status(201).json(cleanBeneficiary(beneficiary));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.patch("/api/beneficiaries/:id", async (req, res) => {
  try {
    const beneficiary = await Beneficiary.findById(req.params.id);
    if (!beneficiary) return res.status(404).json({ message: "Beneficiary not found" });

    const allowedFields = [
      "familyName",
      "householdHead",
      "barangay",
      "purok",
      "locationNote",
      "pin",
      "members",
      "infants",
      "seniors",
      "pwd",
      "pregnant",
      "damageLevel",
      "reliefNeeds",
      "contact",
      "status",
      "source",
      "assignedPartner",
      "consentGiven",
      "isOptedOut",
      "optOutReason",
    ];

    const body = req.body || {};

    allowedFields.forEach((field) => {
      if (body[field] !== undefined) {
        beneficiary[field] = field === "reliefNeeds" ? normalizeNeeds(body[field]) : body[field];
      }
    });

    beneficiary.members = Number(beneficiary.members || 1);
    beneficiary.infants = Number(beneficiary.infants || 0);
    beneficiary.seniors = Number(beneficiary.seniors || 0);
    beneficiary.pwd = Number(beneficiary.pwd || 0);
    beneficiary.pregnant = Number(beneficiary.pregnant || 0);
    beneficiary.deprivationScore = computeDeprivationScore(beneficiary);

    await beneficiary.save();

    res.json(cleanBeneficiary(beneficiary));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.patch("/api/beneficiaries/:id/status", async (req, res) => {
  try {
    const status = req.body?.status;

    if (!status) {
      return res.status(400).json({ message: "Status is required." });
    }

    if (!["Pending", "Verified", "Rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status value." });
    }

    const beneficiary = await Beneficiary.findById(req.params.id);
    if (!beneficiary) return res.status(404).json({ message: "Beneficiary not found" });

    beneficiary.status = status;
    beneficiary.deprivationScore = computeDeprivationScore(beneficiary);
    await beneficiary.save();

    res.json(cleanBeneficiary(beneficiary));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Dedicated Opt-Out Endpoint
app.patch("/api/beneficiaries/:id/opt-out", async (req, res) => {
  try {
    const { isOptedOut, optOutReason } = req.body;
    const beneficiary = await Beneficiary.findById(req.params.id);
    if (!beneficiary) return res.status(404).json({ message: "Beneficiary not found" });

    beneficiary.isOptedOut = Boolean(isOptedOut);
    if (optOutReason !== undefined) {
      beneficiary.optOutReason = optOutReason;
    }
    await beneficiary.save();

    res.json(cleanBeneficiary(beneficiary));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get("/api/inventory", async (req, res) => {
  try {
    const inventory = await Inventory.find().sort({ item: 1 });
    res.json(inventory.map((doc) => ({ ...doc.toObject(), id: doc._id })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/inventory", async (req, res) => {
  try {
    const { item, quantity, unit } = req.body;
    const existing = await Inventory.findOne({ item });

    if (existing) {
      existing.quantity += Number(quantity);
      existing.unit = unit || existing.unit;
      await existing.save();
      return res.status(200).json({ ...existing.toObject(), id: existing._id });
    }

    const inventoryItem = await Inventory.create({ item, quantity, unit });
    res.status(201).json({ ...inventoryItem.toObject(), id: inventoryItem._id });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get("/api/distributions", async (req, res) => {
  try {
    const distributions = await Distribution.find().sort({ createdAt: -1 });
    res.json(distributions.map(cleanDistribution));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/distributions", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const body = req.body || {};
    const { beneficiaryId, status = "Scheduled", encodedBy, agency } = body;
    const items = normalizeDistributionItems(body);

    if (!items.length) throw new Error("At least one relief item is required");

    const beneficiary = await Beneficiary.findById(beneficiaryId).session(session);
    if (!beneficiary) throw new Error("Beneficiary not found");

    const processedByItem = await getProcessedReliefByBeneficiary(beneficiaryId, session);
    validateDistributionAgainstNeeds(beneficiary, items, processedByItem);

    for (const line of items) {
      const inventoryItem = await Inventory.findOne({ item: line.item }).session(session);
      if (!inventoryItem) throw new Error(`Inventory item not found: ${line.item}`);
      if (inventoryItem.quantity < Number(line.quantity)) throw new Error(`Not enough inventory stock for ${line.item}`);
      inventoryItem.quantity -= Number(line.quantity);
      await inventoryItem.save({ session });
    }

    const [distribution] = await Distribution.create(
      [
        {
          beneficiaryId,
          householdHead: beneficiary.householdHead,
          barangay: beneficiary.barangay,
          items,
          agency: agency || "CSWD (City Social Welfare & Development)",
          status,
          encodedBy,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    res.status(201).json(cleanDistribution(distribution));
  } catch (error) {
    await session.abortTransaction();
    res.status(400).json({ message: error.message });
  } finally {
    session.endSession();
  }
});

app.patch("/api/distributions/:id/status", async (req, res) => {
  try {
    const status = req.body?.status;

    if (!status) {
      return res.status(400).json({ message: "Status is required." });
    }

    if (!["Scheduled", "Delivered"].includes(status)) {
      return res.status(400).json({ message: "Invalid distribution status value." });
    }

    const distribution = await Distribution.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!distribution) return res.status(404).json({ message: "Distribution log not found" });
    res.json(cleanDistribution(distribution));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete("/api/distributions/:id", async (req, res) => {
  const allowedRoles = ["master", "cswd", "barangay"];
  const requesterRole = req.headers["x-reliefsync-role"];

  if (!allowedRoles.includes(requesterRole)) {
    return res.status(403).json({
      message: "This role is not allowed to delete distribution entries.",
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const distribution = await Distribution.findById(req.params.id).session(session);
    if (!distribution) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Distribution log not found" });
    }

    const items = normalizeDistributionItems(distribution);

    for (const line of items) {
      await Inventory.findOneAndUpdate(
        { item: line.item },
        { $inc: { quantity: Number(line.quantity || 0) } },
        { session, new: true }
      );
    }

    await Distribution.findByIdAndDelete(req.params.id).session(session);
    await session.commitTransaction();

    res.json({
      ok: true,
      deletedId: req.params.id,
      returnedItems: items,
      message: "Distribution entry deleted and items returned to inventory.",
    });
  } catch (error) {
    await session.abortTransaction();
    res.status(400).json({ message: error.message });
  } finally {
    session.endSession();
  }
});

app.post("/api/reset-trial-data", async (req, res) => {
  const requesterRole = req.headers["x-reliefsync-role"];

  if (requesterRole !== "master") {
    return res.status(403).json({
      message: "Only Master Admin can reset trial data.",
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    await Beneficiary.deleteMany({}).session(session);
    await Distribution.deleteMany({}).session(session);
    await Inventory.deleteMany({}).session(session);

    const inventory = await Inventory.insertMany(DEFAULT_INVENTORY, { session });

    await session.commitTransaction();

    res.json({
      ok: true,
      message: "Trial data reset successfully.",
      beneficiariesDeleted: true,
      distributionsDeleted: true,
      inventory: inventory.map((doc) => ({ ...doc.toObject(), id: doc._id })),
    });
  } catch (error) {
    await session.abortTransaction();
    res.status(400).json({ message: error.message });
  } finally {
    session.endSession();
  }
});

app.get("/api/reports/barangays", async (req, res) => {
  try {
    const beneficiaries = await Beneficiary.find();
    const distributions = await Distribution.find();

    const barangayNames = [...new Set(beneficiaries.map((b) => b.barangay))].sort();

    const report = barangayNames.map((barangay) => {
      const records = beneficiaries.filter((b) => b.barangay === barangay);
      const deliveredLogs = distributions.filter((d) => d.barangay === barangay && d.status === "Delivered");

      const neededByItem = { ...defaultNeeds };
      records.forEach((record) => {
        const needs = normalizeNeeds(record.reliefNeeds);
        reliefTypes.forEach((item) => {
          neededByItem[item] += Number(needs[item] || 0);
        });
      });

      const deliveredByItem = { ...defaultNeeds };
      deliveredLogs.forEach((log) => {
        normalizeDistributionItems(log).forEach((line) => {
          deliveredByItem[line.item] += Number(line.quantity || 0);
        });
      });

      const needed = Object.values(neededByItem).reduce((sum, value) => sum + Number(value || 0), 0);
      const delivered = Object.values(deliveredByItem).reduce((sum, value) => sum + Number(value || 0), 0);
      const avgPriority = records.length
        ? Math.round(
            records.reduce(
              (sum, b) => sum + Number(b.deprivationScore || computeDeprivationScore(b)),
              0
            ) / records.length
          )
        : 0;
      const gap = Math.max(0, needed - delivered);

      return {
        barangay,
        records: records.length,
        verified: records.filter((b) => b.status === "Verified").length,
        pending: records.filter((b) => b.status === "Pending").length,
        needed,
        delivered,
        gap,
        avgPriority,
        neededByItem,
        deliveredByItem,
        underserved: gap > 0 || avgPriority >= 60,
      };
    });

    res.json(report);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({
    message: `API route not found: ${req.method} ${req.originalUrl}. Restart the backend after replacing server.js.`,
  });
});

async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI);
    const inventoryCount = await Inventory.countDocuments();
    if (inventoryCount === 0) {
      await Inventory.insertMany(DEFAULT_INVENTORY);
    }
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`ReliefSync API running on http://0.0.0.0:${PORT}`);
      console.log(`MongoDB connected: ${MONGODB_URI}`);
    });
  } catch (error) {
    console.error("Failed to start ReliefSync API:", error.message);
    process.exit(1);
  }
}

startServer();