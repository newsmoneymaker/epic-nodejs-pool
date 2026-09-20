/**
 * Block reward of Epic Cash mainnet, the same arithmetic as core/src/consensus.rs of the node
 * (block_total_reward_at_height - reward_foundation_at_height). Amounts are in atomic units (1 EPIC = 1e8).
 * Transaction fees are not included: they are not known without reading the block.
 **/
const EPIC_BASE = 100000000;
const DAY = 1440;

const ERA_1 = DAY * 334;
const ERA_2 = ERA_1 + DAY * 470;
const ERA_3 = ERA_2 + DAY * 601;
const ERA_4 = ERA_3 + DAY * 800;
const ERA_5 = ERA_4 + DAY * 1019;
const ERA_6_LENGTH = DAY * 1460;
const ERA_6_BASE = Math.floor(0.15625 * EPIC_BASE);

const LEVY = [888, 777, 666, 555, 444, 333, 222, 111, 111];
const LEVY_RATIO = 10000;
const LEVY_ERA_1 = DAY * 120;
const LEVY_ERA_2_ONWARDS = DAY * 365;

function totalReward (height) {
	if (height <= ERA_1) return 16 * EPIC_BASE;
	if (height <= ERA_2) return 8 * EPIC_BASE;
	if (height <= ERA_3) return 4 * EPIC_BASE;
	if (height <= ERA_4) return 2 * EPIC_BASE;
	if (height <= ERA_5) return EPIC_BASE;
	// from era 6 the reward halves every 1460 days
	let exp = Math.floor((height - ERA_5 - 1) / ERA_6_LENGTH);
	return Math.floor(ERA_6_BASE / Math.pow(2, exp));
}

function foundationLevy (height) {
	if (height <= 0) return 0;
	let index = 0;
	if (height > LEVY_ERA_1) index = Math.floor((height - LEVY_ERA_1 - 1) / LEVY_ERA_2_ONWARDS) + 1;
	if (index >= LEVY.length) return 0;
	return Math.floor(totalReward(height) * LEVY[index] / LEVY_RATIO);
}

/** What the miners of a block at this height receive (without fees) */
exports.minerReward = function (height) {
	if (!(height > 0)) return 0;
	return totalReward(height) - foundationLevy(height);
};
