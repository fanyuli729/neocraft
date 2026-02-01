import { CHUNK_SIZE } from '@/utils/Constants';
import { BlockType } from '@/types/BlockType';
import type { Chunk } from '@/world/Chunk';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Direction helpers
// ---------------------------------------------------------------------------

const DIRS: [number, number][] = [
  [1, 0],  // +X
  [-1, 0], // -X
  [0, 1],  // +Z
  [0, -1], // -Z
];

// ---------------------------------------------------------------------------
// MineshaftGenerator
// ---------------------------------------------------------------------------

/**
 * Generates underground mineshaft tunnel networks within individual chunks.
 *
 * Each qualifying chunk gets a network of 3-block-tall horizontal corridors
 * with oak plank support beams and periodic torches.  Tunnels are carved
 * through stone only, preserving caves, water, and ores.
 *
 * Spawn rate: ~3 % of chunks contain a mineshaft segment.
 * Y-range: 12 -- 42 (deep underground).
 */
export class MineshaftGenerator {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  generate(chunk: Chunk, worldX: number, worldZ: number): void {
    const rng = this.chunkRng(worldX, worldZ);

    // ~3 % of chunks get a mineshaft network
    if (rng() > 0.03) return;

    const baseY = 12 + Math.floor(rng() * 30); // Y 12-42

    // Pick a random starting position within the chunk interior
    const startX = 2 + Math.floor(rng() * (CHUNK_SIZE - 4));
    const startZ = 2 + Math.floor(rng() * (CHUNK_SIZE - 4));

    // Verify we're underground (should be stone)
    if (!this.isStone(chunk, startX, baseY, startZ)) return;

    // Build a network of connected corridors
    this.buildNetwork(chunk, rng, startX, baseY, startZ);
  }

  // -----------------------------------------------------------------------
  // Network builder
  // -----------------------------------------------------------------------

  /**
   * Build a network of 3-5 connected corridors branching from a hub.
   */
  private buildNetwork(
    chunk: Chunk,
    rng: () => number,
    startX: number,
    baseY: number,
    startZ: number,
  ): void {
    // Place a small hub room (3x3x3)
    this.carveRoom(chunk, startX - 1, baseY, startZ - 1, 3, 3, 3);
    this.placeTorch(chunk, startX, baseY + 2, startZ);

    // Branch corridors in random directions
    const branchCount = 3 + Math.floor(rng() * 3); // 3-5 branches
    const shuffledDirs = this.shuffleDirs(rng);

    for (let b = 0; b < branchCount && b < shuffledDirs.length; b++) {
      const [dx, dz] = shuffledDirs[b % shuffledDirs.length];
      const length = 8 + Math.floor(rng() * 16); // 8-23 blocks long

      this.carveCorridor(chunk, rng, startX, baseY, startZ, dx, dz, length);

      // Chance of a secondary branch from the end of this corridor
      if (rng() < 0.4) {
        const endX = startX + dx * length;
        const endZ = startZ + dz * length;
        if (this.inBounds(endX, endZ)) {
          // Turn 90 degrees
          const turnDir = dz === 0
            ? DIRS[2 + Math.floor(rng() * 2)] // turn to +Z or -Z
            : DIRS[Math.floor(rng() * 2)];     // turn to +X or -X
          const subLen = 6 + Math.floor(rng() * 10);
          this.carveCorridor(chunk, rng, endX, baseY, endZ, turnDir[0], turnDir[1], subLen);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Corridor carving
  // -----------------------------------------------------------------------

  /**
   * Carve a single corridor in the given direction.
   * Width: 3 blocks (center + 1 on each side perpendicular to direction).
   * Height: 3 blocks.
   * Places support beams every 4 blocks and torches every 8 blocks.
   */
  private carveCorridor(
    chunk: Chunk,
    rng: () => number,
    sx: number,
    sy: number,
    sz: number,
    dx: number,
    dz: number,
    length: number,
  ): void {
    // Perpendicular direction for corridor width
    const px = dz !== 0 ? 1 : 0;
    const pz = dx !== 0 ? 1 : 0;

    for (let step = 0; step < length; step++) {
      const cx = sx + dx * step;
      const cz = sz + dz * step;

      // Check bounds
      if (!this.inBounds(cx - px, cz - pz) || !this.inBounds(cx + px, cz + pz)) break;

      // Carve the 3-wide, 3-tall corridor
      for (let w = -1; w <= 1; w++) {
        const bx = cx + px * w;
        const bz = cz + pz * w;

        for (let dy = 0; dy < 3; dy++) {
          const by = sy + dy;
          if (by < 1 || by >= 255) continue;

          const existing = chunk.getBlock(bx, by, bz);
          if (existing === BlockType.BEDROCK || existing === BlockType.WATER) continue;

          chunk.setBlock(bx, by, bz, BlockType.AIR);
        }
      }

      // Floor: place planks as walkway (center block only)
      if (this.isStoneOrAir(chunk, cx, sy - 1, cz)) {
        chunk.setBlock(cx, sy - 1, cz, BlockType.PLANKS_OAK);
      }

      // Support beams every 4 blocks
      if (step % 4 === 0) {
        this.placeSupport(chunk, cx, sy, cz, px, pz);
      }

      // Torches every 8 blocks (on the left wall)
      if (step % 8 === 4 && step > 0) {
        const torchX = cx + px;
        const torchZ = cz + pz;
        this.placeTorch(chunk, torchX, sy + 1, torchZ);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Support beams
  // -----------------------------------------------------------------------

  /**
   * Place a support beam across the corridor: two vertical oak log pillars
   * on either side with a plank beam across the top.
   */
  private placeSupport(
    chunk: Chunk,
    cx: number,
    sy: number,
    cz: number,
    px: number,
    pz: number,
  ): void {
    // Left pillar
    const lx = cx - px;
    const lz = cz - pz;
    if (this.inBounds(lx, lz)) {
      for (let dy = 0; dy < 3; dy++) {
        chunk.setBlock(lx, sy + dy, lz, BlockType.WOOD_OAK);
      }
    }

    // Right pillar
    const rx = cx + px;
    const rz = cz + pz;
    if (this.inBounds(rx, rz)) {
      for (let dy = 0; dy < 3; dy++) {
        chunk.setBlock(rx, sy + dy, rz, BlockType.WOOD_OAK);
      }
    }

    // Top beam (planks across)
    for (let w = -1; w <= 1; w++) {
      const bx = cx + px * w;
      const bz = cz + pz * w;
      if (this.inBounds(bx, bz)) {
        chunk.setBlock(bx, sy + 2, bz, BlockType.PLANKS_OAK);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Room carving
  // -----------------------------------------------------------------------

  private carveRoom(
    chunk: Chunk,
    sx: number,
    sy: number,
    sz: number,
    w: number,
    h: number,
    d: number,
  ): void {
    for (let x = sx; x < sx + w; x++) {
      for (let z = sz; z < sz + d; z++) {
        if (!this.inBounds(x, z)) continue;
        for (let dy = 0; dy < h; dy++) {
          const y = sy + dy;
          if (y < 1 || y >= 255) continue;
          const existing = chunk.getBlock(x, y, z);
          if (existing === BlockType.BEDROCK || existing === BlockType.WATER) continue;
          chunk.setBlock(x, y, z, BlockType.AIR);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private placeTorch(chunk: Chunk, x: number, y: number, z: number): void {
    if (this.inBounds(x, z) && y >= 1 && y < 255) {
      chunk.setBlock(x, y, z, BlockType.TORCH);
    }
  }

  private isStone(chunk: Chunk, x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, z) || y < 0 || y >= 256) return false;
    return chunk.getBlock(x, y, z) === BlockType.STONE;
  }

  private isStoneOrAir(chunk: Chunk, x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, z) || y < 0 || y >= 256) return false;
    const b = chunk.getBlock(x, y, z);
    return b === BlockType.STONE || b === BlockType.AIR;
  }

  private inBounds(x: number, z: number): boolean {
    return x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE;
  }

  private shuffleDirs(rng: () => number): [number, number][] {
    const arr = [...DIRS];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private chunkRng(worldX: number, worldZ: number): () => number {
    let h = this.seed + 0x4d696e65; // "Mine" in hex
    h = (h ^ (worldX * 492876847)) | 0;
    h = (h ^ (worldZ * 715225739)) | 0;
    h = (Math.imul(h ^ (h >>> 13), 1597334677) + 0xc3a5c85c) | 0;
    return mulberry32(h);
  }
}
