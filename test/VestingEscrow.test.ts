import { ethers } from "hardhat";
import { BigNumber, BigNumberish } from "ethers";
import { expect } from "chai";
import {
  ERC20,
  VestingEscrowFactory,
  VestingEscrowSimple,
} from "../dist/types";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

async function advanceBlockTo(blockNumber: BigNumberish) {
  for (let i = await ethers.provider.getBlockNumber(); i < blockNumber; i++) {
    return ethers.provider.send("evm_mine", []);
  }
}

const e18 = BigNumber.from(10).pow(18);

describe("VestingEscrowSimple", function () {
  let signers: SignerWithAddress[];
  let funder: SignerWithAddress;
  let recipient: SignerWithAddress;
  let token: ERC20;
  let escrowFactory: VestingEscrowFactory;
  let escrow: VestingEscrowSimple;
  let start: number;

  before(async function () {
    signers = await ethers.getSigners();
    funder = signers[0];
    recipient = signers[1];
    const referenceEscrow = await (
      await ethers.getContractFactory("VestingEscrowSimple", funder)
    ).deploy();
    escrowFactory = <VestingEscrowFactory>(
      await (
        await ethers.getContractFactory("VestingEscrowFactory", funder)
      ).deploy(referenceEscrow.address)
    );
  });

  beforeEach(async function () {
    token = <ERC20>(
      await (
        await ethers.getContractFactory("ERC20", funder)
      ).deploy("Milky", "MILK", 18)
    );
    await token._mint_for_testing(e18);
    await token.approve(escrowFactory.address, e18);
    const createEscrowTx = await (
      await escrowFactory[
        "deploy_vesting_contract(address,address,uint256,uint256)"
      ](token.address, recipient.address, e18, 10000000)
    ).wait();
    escrow = <VestingEscrowSimple>(
      await ethers.getContractAt(
        "VestingEscrowSimple",
        createEscrowTx.events![3].address,
        funder
      )
    );
    start = (await ethers.provider.getBlock(createEscrowTx.blockNumber))
      .timestamp;
  });

  it("contract deploys with expected funds and state", async function () {
    expect(await token.balanceOf(escrow.address)).eq(e18);
    expect(await escrow.total_locked()).eq(e18);
    expect(await escrow.recipient()).eq(recipient.address);
    expect(await escrow.total_claimed()).eq(0);
    expect(await escrow.start_time()).eq(start);
    expect(await escrow.end_time()).eq(start + 10000000);
  });

  it("admin can transfer and renounce rights", async function () {
    expect(await escrow.admin()).eq(funder.address);
    const newAdmin = signers[2];
    await escrow.commit_transfer_ownership(newAdmin.address);
    expect(await escrow.future_admin()).eq(newAdmin.address);
    await escrow.connect(newAdmin).apply_transfer_ownership();
    expect(await escrow.admin()).eq(newAdmin.address);
    await escrow.connect(newAdmin).renounce_ownership();
    expect(await escrow.admin()).eq(ethers.constants.AddressZero);
  });

  it("only admin can rug locked tokens", async function () {
    await expect(escrow.connect(signers[2]).rug_pull()).to.be.reverted;
    await ethers.provider.send("evm_increaseTime", [5000000]);
    const rugTx = await (await escrow.rug_pull()).wait();
    const rugTimestamp = (await ethers.provider.getBlock(rugTx.blockNumber))
      .timestamp;
    await ethers.provider.send("evm_increaseTime", [5000000]);
    const expectedClaimable = e18
      .mul(BigNumber.from(rugTimestamp).sub(start))
      .div((await escrow.end_time()).sub(start));
    await escrow.connect(recipient)["claim()"]();
    expect(await token.balanceOf(recipient.address)).eq(expectedClaimable);
    expect(await token.balanceOf(funder.address)).eq(
      (await escrow.total_locked()).sub(expectedClaimable)
    );
  });

  it("recipient can claim linearly unlocked tokens", async function () {
    await ethers.provider.send("evm_increaseTime", [3000000]);
    const claimTx = await (await escrow.connect(recipient)["claim()"]()).wait();
    const claimTimestamp = (await ethers.provider.getBlock(claimTx.blockNumber))
      .timestamp;
    const expected = e18
      .mul(BigNumber.from(claimTimestamp).sub(start))
      .div((await escrow.end_time()).sub(start));
    expect(await token.balanceOf(recipient.address)).eq(expected);
    expect(await token.balanceOf(escrow.address)).eq(
      (await escrow.total_locked()).sub(expected)
    );
    expect(await escrow.total_claimed()).eq(expected);
    await ethers.provider.send("evm_increaseTime", [10000000]);
    await escrow.connect(recipient)["claim()"]();
    expect(await token.balanceOf(recipient.address)).eq(
      await escrow.total_locked()
    );
    expect(await escrow.total_claimed()).eq(await escrow.total_locked());
  });
});
