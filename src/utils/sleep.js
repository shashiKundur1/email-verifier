/**
 * src/utils/sleep.js
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomDelay = (min, max) =>
  Math.floor(Math.random() * (max - min + 1) + min);

module.exports = { sleep, randomDelay };
