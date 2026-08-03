const path = require("path");
const Order = require(path.join(__dirname, '..', 'models', 'Order'));

async function get(reference) {
  return await Order.findOne({ reference }).lean();
}

async function save(order) {
  return await Order.findOneAndUpdate(
    { reference: order.reference },
    order,
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  ).lean();
}

async function list() {
  return await Order.find()
    .sort({ createdAt: -1 })
    .lean();
}

async function findByAnyReference(reference) {
  if (!reference) return null;

  const needle = String(reference).trim().toUpperCase();

  let order = await Order.findOne({
    reference: needle,
  }).lean();

  if (order) return order;

  order = await Order.findOne({
    "fulfillment.orderReference": needle,
  }).lean();

  if (order) return order;

  order = await Order.findOne({
    "fulfillment.reference": needle,
  }).lean();

  return order;
}

const locks = new Map();

async function withLock(reference, fn) {
  const previous = locks.get(reference) || Promise.resolve();

  let release;

  const current = new Promise((resolve) => {
    release = resolve;
  });

  locks.set(reference, previous.then(() => current));

  await previous;

  try {
    return await fn();
  } finally {
    release();

    if (locks.get(reference) === current) {
      locks.delete(reference);
    }
  }
}

async function remove(reference) {
  return await Order.findOneAndDelete({
    reference,
  });
}
  
module.exports = {
  get,
  save,
  list,
  findByAnyReference,
  withLock,
  remove
};