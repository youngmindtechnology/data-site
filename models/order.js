const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    type: {
      type: String,
      enum: ["data", "checker"],
      required: true,
    },

    status: {
      type: String,
      default: "pending",
    },

    network: String,
    capacity: String,
    checkerType: String,

    phoneNumber: String,
    momoPhone: String,
    momoNetwork: String,
    email: String,

    amount: Number,

    costPrice: Number,

    costEstimated: { type: Boolean, default: false },

    authorizationUrl: String,
    chargeStatus: String,

    fulfillment: mongoose.Schema.Types.Mixed,
    fulfillmentError: String,

    // NEW — DataMart's own reference for this order, promoted to a
    // top-level indexed field so delivery polling can query it directly
    dataMartReference: { type: String, index: true },

    // NEW — delivery tracking
    deliveryConfirmed: { type: Boolean, default: false },
    deliveredSmsSent: { type: Boolean, default: false },
    delayNoticeSent: { type: Boolean, default: false },
    lastLiveStatus: String,
    lastCheckedAt: Date,

    skipSms: Boolean,
    confirmationSmsSent: {
      type: Boolean,
      default: false,
    },
    failureSmsSent: {
      type: Boolean,
      default: false,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  }
);

module.exports = mongoose.model("Order", OrderSchema);