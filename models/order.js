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

    authorizationUrl: String,
    chargeStatus: String,

    fulfillment: mongoose.Schema.Types.Mixed,
    fulfillmentError: String,

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