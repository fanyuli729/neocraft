import { CHUNK_SIZE, CHUNK_HEIGHT } from '@/utils/Constants';
import { BlockType } from '@/types/BlockType';
import { Biome, BiomeMap } from '@/terrain/BiomeMap';
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
// StructureGenerator
// ---------------------------------------------------------------------------

/**
 * Places structures and biome-appropriate decorations on an already-generated
 * chunk.
 *
 * Phase 1 -- large structures (desert wells, cabins, dungeons).
 * Phase 2 -- per-column surface decorations (tall grass, flowers, cacti).
 *
 * Run *after* trees so that flowers are not placed underneath canopies.
 */
export class StructureGenerator {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  generate(
    chunk: Chunk,
    heightmap: number[][],
    biomeMap: BiomeMap,
    worldX: number,
    worldZ: number,
  ): void {
    const rng = this.chunkRng(worldX, worldZ);

    // --- Phase 1: large structures (at most one per chunk) ---
    this.placeStructures(chunk, heightmap, biomeMap, worldX, worldZ, rng);

    // --- Phase 2: per-column surface decorations ---
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = worldX + lx;
        const wz = worldZ + lz;
        const surfaceY = heightmap[lx][lz];
        const biome = biomeMap.getBiome(wx, wz);

        const placeY = surfaceY + 1;
        if (placeY >= 256) continue;
        if (chunk.getBlock(lx, placeY, lz) !== BlockType.AIR) continue;

        switch (biome) {
          case Biome.PLAINS:
            this.decoratePlains(chunk, lx, placeY, lz, rng);
            break;
          case Biome.FOREST:
            this.decorateForest(chunk, lx, placeY, lz, rng);
            break;
          case Biome.DESERT:
            this.decorateDesert(chunk, lx, placeY, lz, rng);
            break;
          case Biome.TAIGA:
            this.decorateTaiga(chunk, lx, placeY, lz, rng);
            break;
          case Biome.TUNDRA:
            this.decorateTundra(chunk, lx, placeY, lz, rng);
            break;
          case Biome.JUNGLE:
            this.decorateJungle(chunk, lx, placeY, lz, rng);
            break;
          case Biome.SWAMP:
            this.decorateSwamp(chunk, lx, placeY, lz, rng);
            break;
          default:
            break;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase 1 -- Structure placement
  // -----------------------------------------------------------------------

  private placeStructures(
    chunk: Chunk,
    heightmap: number[][],
    biomeMap: BiomeMap,
    worldX: number,
    worldZ: number,
    rng: () => number,
  ): void {
    // Use a separate RNG stream so structure rolls don't affect decoration RNG
    const structRng = this.structureRng(worldX, worldZ);

    const centerBiome = biomeMap.getBiome(worldX + 8, worldZ + 8);

    // Desert well (~3 % of desert chunks)
    if (centerBiome === Biome.DESERT && structRng() < 0.03) {
      if (this.tryPlaceDesertWell(chunk, heightmap, structRng)) return;
    }

    // Cabin (~2 % of plains/forest chunks)
    if ((centerBiome === Biome.PLAINS || centerBiome === Biome.FOREST) && structRng() < 0.02) {
      if (this.tryPlaceCabin(chunk, heightmap, structRng)) return;
    }

    // Underground dungeon (~5 % of any chunk)
    if (structRng() < 0.05) {
      this.tryPlaceDungeon(chunk, structRng);
    }
  }

  // -----------------------------------------------------------------------
  // Desert Well
  // -----------------------------------------------------------------------

  /**
   * 5x5 sandstone well with water basin dug 2 blocks into the ground.
   *
   *   Y-2:  3x3 sandstone floor
   *   Y-1:  3x3 water
   *   Y+0:  5x5 sandstone ring, 3x3 water center
   *   Y+1:  sandstone rim (5x5 ring, open center)
   */
  private tryPlaceDesertWell(
    chunk: Chunk,
    heightmap: number[][],
    rng: () => number,
  ): boolean {
    const W = 5;
    const sx = 3 + Math.floor(rng() * (CHUNK_SIZE - W - 6));
    const sz = 3 + Math.floor(rng() * (CHUNK_SIZE - W - 6));

    if (!this.isFlatArea(heightmap, sx, sz, W, W, 1)) return false;

    const baseY = heightmap[sx + 2][sz + 2]; // center height

    // Dig basin (3x3, 2 deep)
    for (let x = sx + 1; x < sx + 4; x++) {
      for (let z = sz + 1; z < sz + 4; z++) {
        chunk.setBlock(x, baseY - 1, z, BlockType.SAND_STONE); // floor
        chunk.setBlock(x, baseY, z, BlockType.WATER);           // water level
      }
    }

    // 5x5 sandstone ring at surface level
    for (let x = sx; x < sx + W; x++) {
      for (let z = sz; z < sz + W; z++) {
        const inner = x > sx && x < sx + W - 1 && z > sz && z < sz + W - 1;
        if (!inner) {
          // Fill ground to base level for uneven terrain
          chunk.setBlock(x, baseY, z, BlockType.SAND_STONE);
        }
      }
    }

    // Rim 1 block above ground (ring only)
    for (let x = sx; x < sx + W; x++) {
      for (let z = sz; z < sz + W; z++) {
        const inner = x > sx && x < sx + W - 1 && z > sz && z < sz + W - 1;
        if (!inner) {
          chunk.setBlock(x, baseY + 1, z, BlockType.SAND_STONE);
        }
        // Clear above rim
        chunk.setBlock(x, baseY + 2, z, BlockType.AIR);
      }
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Cabin
  // -----------------------------------------------------------------------

  /**
   * 7x5 wooden cabin with oak log frame, plank walls, glass windows,
   * and interior furnishing (torch + crafting table).
   *
   *   Y+0:  7x5 cobblestone floor
   *   Y+1:  walls (planks), corners (oak log), door opening on south
   *   Y+2:  walls with glass windows on east/west sides
   *   Y+3:  walls (planks), corners (oak log)
   *   Y+4:  7x5 plank roof
   */
  private tryPlaceCabin(
    chunk: Chunk,
    heightmap: number[][],
    rng: () => number,
  ): boolean {
    const W = 7;
    const D = 5;
    const sx = 2 + Math.floor(rng() * (CHUNK_SIZE - W - 4));
    const sz = 2 + Math.floor(rng() * (CHUNK_SIZE - D - 4));

    if (!this.isFlatArea(heightmap, sx, sz, W, D, 2)) return false;

    const baseY = heightmap[sx + 3][sz + 2]; // center height

    // --- Floor (Y+0): cobblestone ---
    for (let x = sx; x < sx + W; x++) {
      for (let z = sz; z < sz + D; z++) {
        chunk.setBlock(x, baseY, z, BlockType.COBBLESTONE);
      }
    }

    // --- Walls (Y+1 to Y+3) ---
    for (let dy = 1; dy <= 3; dy++) {
      const y = baseY + dy;

      for (let x = sx; x < sx + W; x++) {
        for (let z = sz; z < sz + D; z++) {
          const onEdge =
            x === sx || x === sx + W - 1 || z === sz || z === sz + D - 1;
          const isCorner =
            (x === sx || x === sx + W - 1) && (z === sz || z === sz + D - 1);

          if (isCorner) {
            chunk.setBlock(x, y, z, BlockType.WOOD_OAK);
          } else if (onEdge) {
            // Door opening: center of south wall (sz + D - 1), Y+1 and Y+2
            const isDoor =
              z === sz + D - 1 && x === sx + 3 && dy <= 2;

            // Windows: east/west walls at Y+2
            const isWindow =
              dy === 2 &&
              (x === sx || x === sx + W - 1) &&
              z > sz && z < sz + D - 1;

            if (isDoor) {
              chunk.setBlock(x, y, z, BlockType.AIR);
            } else if (isWindow) {
              chunk.setBlock(x, y, z, BlockType.GLASS);
            } else {
              chunk.setBlock(x, y, z, BlockType.PLANKS_OAK);
            }
          } else {
            // Interior air
            chunk.setBlock(x, y, z, BlockType.AIR);
          }
        }
      }
    }

    // --- Roof (Y+4): planks ---
    for (let x = sx; x < sx + W; x++) {
      for (let z = sz; z < sz + D; z++) {
        chunk.setBlock(x, baseY + 4, z, BlockType.PLANKS_OAK);
      }
    }

    // Clear above roof
    for (let x = sx; x < sx + W; x++) {
      for (let z = sz; z < sz + D; z++) {
        chunk.setBlock(x, baseY + 5, z, BlockType.AIR);
      }
    }

    // --- Interior furnishing ---
    // Torch on north wall
    chunk.setBlock(sx + 3, baseY + 2, sz + 1, BlockType.TORCH);
    // Crafting table in corner
    chunk.setBlock(sx + 1, baseY + 1, sz + 1, BlockType.CRAFTING_TABLE);
    // Furnace next to crafting table
    chunk.setBlock(sx + 2, baseY + 1, sz + 1, BlockType.FURNACE);

    return true;
  }

  // -----------------------------------------------------------------------
  // Underground Dungeon
  // -----------------------------------------------------------------------

  /**
   * 7x7x5 cobblestone room carved underground with torches.
   *
   *   Walls, floor, ceiling: cobblestone
   *   Interior: 5x5x3 air space
   *   Torches on the 4 walls (center of each)
   */
  private tryPlaceDungeon(
    chunk: Chunk,
    rng: () => number,
  ): boolean {
    const W = 7;
    const H = 5;

    // Try a few random positions underground
    for (let attempt = 0; attempt < 5; attempt++) {
      const sx = 2 + Math.floor(rng() * (CHUNK_SIZE - W - 2));
      const sz = 2 + Math.floor(rng() * (CHUNK_SIZE - W - 2));
      const sy = 12 + Math.floor(rng() * 28); // Y 12-40

      // Verify we're underground (center should be stone)
      if (chunk.getBlock(sx + 3, sy + 2, sz + 3) !== BlockType.STONE) continue;
      // Verify ceiling is underground too
      if (chunk.getBlock(sx + 3, sy + H, sz + 3) !== BlockType.STONE) continue;

      this.buildDungeon(chunk, sx, sy, sz, W, H);
      return true;
    }

    return false;
  }

  private buildDungeon(
    chunk: Chunk,
    sx: number,
    sy: number,
    sz: number,
    W: number,
    H: number,
  ): void {
    for (let x = sx; x < sx + W; x++) {
      for (let z = sz; z < sz + W; z++) {
        for (let dy = 0; dy < H; dy++) {
          const y = sy + dy;
          if (y >= CHUNK_HEIGHT) continue;

          const isFloor = dy === 0;
          const isCeiling = dy === H - 1;
          const isWall =
            x === sx || x === sx + W - 1 || z === sz || z === sz + W - 1;

          if (isFloor || isCeiling || isWall) {
            chunk.setBlock(x, y, z, BlockType.COBBLESTONE);
          } else {
            chunk.setBlock(x, y, z, BlockType.AIR);
          }
        }
      }
    }

    // Place torches on walls (center of each side, Y+2)
    const midX = sx + Math.floor(W / 2);
    const midZ = sz + Math.floor(W / 2);
    const torchY = sy + 2;

    chunk.setBlock(midX, torchY, sz + 1, BlockType.TORCH);     // north wall
    chunk.setBlock(midX, torchY, sz + W - 2, BlockType.TORCH); // south wall
    chunk.setBlock(sx + 1, torchY, midZ, BlockType.TORCH);     // west wall
    chunk.setBlock(sx + W - 2, torchY, midZ, BlockType.TORCH); // east wall
  }

  // -----------------------------------------------------------------------
  // Phase 2 -- Per-biome surface decoration
  // -----------------------------------------------------------------------

  /** Plains: tall grass (30 %) and occasional flowers (5 %). */
  private decoratePlains(
    chunk: Chunk,
    lx: number,
    y: number,
    lz: number,
    rng: () => number,
  ): void {
    const roll = rng();
    if (roll < 0.30) {
      chunk.setBlock(lx, y, lz, BlockType.TALL_GRASS);
    } else if (roll < 0.33) {
      chunk.setBlock(lx, y, lz, rng() < 0.5 ? BlockType.FLOWER_RED : BlockType.FLOWER_YELLOW);
    }
  }

  /** Forest: taller grass density (35 %) and more flowers (8 %). */
  private decorateForest(
    chunk: Chunk,
    lx: number,
    y: number,
    lz: number,
    rng: () => number,
  ): void {
    const roll = rng();
    if (roll < 0.35) {
      chunk.setBlock(lx, y, lz, BlockType.TALL_GRASS);
    } else if (roll < 0.43) {
      chunk.setBlock(lx, y, lz, rng() < 0.5 ? BlockType.FLOWER_RED : BlockType.FLOWER_YELLOW);
    }
  }

  /** Desert: cacti (2 %) that grow 2-3 blocks tall. */
  private decorateDesert(
    chunk: Chunk,
    lx: number,
    y: number,
    lz: number,
    rng: () => number,
  ): void {
    if (rng() >= 0.02) return;

    if (!this.hasClearNeighbours(chunk, lx, y, lz)) return;

    const height = 2 + Math.floor(rng() * 2);
    for (let dy = 0; dy < height; dy++) {
      if (y + dy >= 256) break;
      chunk.setBlock(lx, y + dy, lz, BlockType.CACTUS);
    }
  }

  /** Taiga: sparse tall grass (15 %). */
  private decorateTaiga(
    chunk: Chunk,
    lx: number,
    y: number,
    lz: number,
    rng: () => number,
  ): void {
    if (rng() < 0.15) {
      chunk.setBlock(lx, y, lz, BlockType.TALL_GRASS);
    }
  }

  /** Jungle: dense tall grass (40 %) and flowers (10 %). */
  private decorateJungle(
    chunk: Chunk,
    lx: number,
    y: number,
    lz: number,
    rng: () => number,
  ): void {
    const roll = rng();
    if (roll < 0.40) {
      chunk.setBlock(lx, y, lz, BlockType.TALL_GRASS);
    } else if (roll < 0.50) {
      chunk.setBlock(lx, y, lz, rng() < 0.6 ? BlockType.FLOWER_RED : BlockType.FLOWER_YELLOW);
    }
  }

  /** Swamp: tall grass (25 %) with sparse flowers (3 %). */
  private decorateSwamp(
    chunk: Chunk,
    lx: number,
    y: number,
    lz: number,
    rng: () => number,
  ): void {
    const roll = rng();
    if (roll < 0.25) {
      chunk.setBlock(lx, y, lz, BlockType.TALL_GRASS);
    } else if (roll < 0.28) {
      chunk.setBlock(lx, y, lz, BlockType.FLOWER_RED);
    }
  }

  /** Tundra: very sparse flowers (2 %). */
  private decorateTundra(
    chunk: Chunk,
    lx: number,
    y: number,
    lz: number,
    rng: () => number,
  ): void {
    if (rng() < 0.02) {
      chunk.setBlock(lx, y, lz, BlockType.FLOWER_YELLOW);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private hasClearNeighbours(
    chunk: Chunk,
    lx: number,
    y: number,
    lz: number,
  ): boolean {
    const neighbours: [number, number][] = [
      [lx - 1, lz],
      [lx + 1, lz],
      [lx, lz - 1],
      [lx, lz + 1],
    ];
    for (const [nx, nz] of neighbours) {
      if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) continue;
      if (chunk.getBlock(nx, y, nz) !== BlockType.AIR) return false;
    }
    return true;
  }

  /**
   * Check whether a rectangular area of the heightmap is sufficiently flat.
   */
  private isFlatArea(
    heightmap: number[][],
    startX: number,
    startZ: number,
    width: number,
    depth: number,
    maxVariation: number,
  ): boolean {
    let minH = Infinity;
    let maxH = -Infinity;
    for (let x = startX; x < startX + width; x++) {
      for (let z = startZ; z < startZ + depth; z++) {
        if (x < 0 || x >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) return false;
        const h = heightmap[x][z];
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    return (maxH - minH) <= maxVariation;
  }

  /** Per-chunk deterministic seed for decorations. */
  private chunkRng(worldX: number, worldZ: number): () => number {
    let h = this.seed;
    h = (h ^ (worldX * 374761393)) | 0;
    h = (h ^ (worldZ * 668265263)) | 0;
    h = (Math.imul(h ^ (h >>> 13), 1274126177) + 0xa5b3c2d1) | 0;
    return mulberry32(h);
  }

  /** Separate per-chunk seed stream for structures (doesn't affect decoration RNG). */
  private structureRng(worldX: number, worldZ: number): () => number {
    let h = this.seed + 0x7f3a9c1d;
    h = (h ^ (worldX * 597399067)) | 0;
    h = (h ^ (worldZ * 824521439)) | 0;
    h = (Math.imul(h ^ (h >>> 13), 1946318589) + 0xb7e15163) | 0;
    return mulberry32(h);
  }
}
