import * as THREE from 'three';
import { Biome, BiomeMap } from '@/terrain/BiomeMap';

// ---------------------------------------------------------------------------
// Weather types
// ---------------------------------------------------------------------------

export enum WeatherState {
  CLEAR,
  RAIN,
  SNOW,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PARTICLE_COUNT = 800;
const SPAWN_RADIUS = 40;
const SPAWN_HEIGHT = 30;

const RAIN_SPEED = 18;
const SNOW_SPEED = 3.5;
const SNOW_DRIFT = 1.5;

/** Seconds to fade weather in/out. */
const FADE_DURATION = 5;

/** Min/max duration of a weather event (seconds). */
const WEATHER_MIN_DURATION = 120;
const WEATHER_MAX_DURATION = 300;

/** Min/max duration of clear sky between events (seconds). */
const CLEAR_MIN_DURATION = 180;
const CLEAR_MAX_DURATION = 480;

// ---------------------------------------------------------------------------
// WeatherSystem
// ---------------------------------------------------------------------------

/**
 * Manages dynamic weather (rain and snow) with particle rendering,
 * sky darkening, and biome-aware precipitation type.
 *
 * Uses THREE.Points for efficient rendering of many particles.
 */
export class WeatherSystem {
  private state: WeatherState = WeatherState.CLEAR;
  private targetState: WeatherState = WeatherState.CLEAR;

  /** 0 = fully clear, 1 = fully active weather. */
  private intensity = 0;

  /** Countdown until the next weather change. */
  private timer: number;

  /** The points mesh for precipitation particles. */
  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private positions: Float32Array | null = null;
  private velocities: Float32Array | null = null;

  private biomeMap: BiomeMap | null = null;

  constructor() {
    // Start with a random clear-sky duration
    this.timer = CLEAR_MIN_DURATION + Math.random() * (CLEAR_MAX_DURATION - CLEAR_MIN_DURATION);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  init(scene: THREE.Scene, biomeMap: BiomeMap): void {
    this.biomeMap = biomeMap;

    // Allocate particle buffers
    this.positions = new Float32Array(PARTICLE_COUNT * 3);
    this.velocities = new Float32Array(PARTICLE_COUNT * 3);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xccddff,
      size: 0.15,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  // -----------------------------------------------------------------------
  // Per-frame update
  // -----------------------------------------------------------------------

  update(dt: number, playerX: number, playerY: number, playerZ: number): void {
    if (!this.points || !this.positions || !this.velocities) return;

    // --- Weather state machine ---
    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.targetState === WeatherState.CLEAR) {
        // Start weather -- choose rain or snow based on biome at player position
        this.targetState = this.choosePrecipitation(playerX, playerZ);
        if (this.targetState === WeatherState.CLEAR) {
          // Desert or ocean -- stay clear, retry later
          this.timer = 30 + Math.random() * 60;
        } else {
          this.timer = WEATHER_MIN_DURATION + Math.random() * (WEATHER_MAX_DURATION - WEATHER_MIN_DURATION);
          this.initParticles(playerX, playerY, playerZ);
        }
      } else {
        // End weather
        this.targetState = WeatherState.CLEAR;
        this.timer = CLEAR_MIN_DURATION + Math.random() * (CLEAR_MAX_DURATION - CLEAR_MIN_DURATION);
      }
    }

    // --- Fade intensity ---
    const target = this.targetState !== WeatherState.CLEAR ? 1 : 0;
    if (this.intensity < target) {
      this.intensity = Math.min(1, this.intensity + dt / FADE_DURATION);
    } else if (this.intensity > target) {
      this.intensity = Math.max(0, this.intensity - dt / FADE_DURATION);
    }

    // Track current active state
    if (this.intensity > 0 && this.targetState !== WeatherState.CLEAR) {
      this.state = this.targetState;
    }
    if (this.intensity <= 0) {
      this.state = WeatherState.CLEAR;
    }

    // --- Update visibility and material ---
    const mat = this.points.material as THREE.PointsMaterial;
    if (this.intensity <= 0) {
      this.points.visible = false;
      mat.opacity = 0;
      return;
    }

    this.points.visible = true;
    mat.opacity = this.intensity * 0.6;

    const isSnow = this.state === WeatherState.SNOW;
    mat.size = isSnow ? 0.25 : 0.12;
    mat.color.set(isSnow ? 0xffffff : 0xaabbdd);

    // --- Animate particles ---
    const speed = isSnow ? SNOW_SPEED : RAIN_SPEED;
    const bottomY = playerY - 5;
    const topY = playerY + SPAWN_HEIGHT;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;

      // Move particle
      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] -= speed * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;

      // Respawn at top when below bottom
      if (this.positions[i3 + 1] < bottomY) {
        this.respawnParticle(i, playerX, playerY, playerZ);
      }

      // Keep particles roughly centred on the player (wrap horizontally)
      const dx = this.positions[i3] - playerX;
      const dz = this.positions[i3 + 2] - playerZ;
      if (Math.abs(dx) > SPAWN_RADIUS) {
        this.positions[i3] = playerX + (Math.random() * 2 - 1) * SPAWN_RADIUS;
        this.positions[i3 + 1] = bottomY + Math.random() * (topY - bottomY);
      }
      if (Math.abs(dz) > SPAWN_RADIUS) {
        this.positions[i3 + 2] = playerZ + (Math.random() * 2 - 1) * SPAWN_RADIUS;
        this.positions[i3 + 1] = bottomY + Math.random() * (topY - bottomY);
      }
    }

    (this.geometry!.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Current weather intensity (0 = clear, 1 = full weather). */
  getIntensity(): number {
    return this.intensity;
  }

  /** Current weather state. */
  getState(): WeatherState {
    return this.state;
  }

  /** Whether it's currently raining (intensity > 0 and state is RAIN). */
  isRaining(): boolean {
    return this.state === WeatherState.RAIN && this.intensity > 0;
  }

  /** Whether it's currently snowing (intensity > 0 and state is SNOW). */
  isSnowing(): boolean {
    return this.state === WeatherState.SNOW && this.intensity > 0;
  }

  /**
   * Sky darkening factor for rain/snow.
   * 0 = no darkening, 1 = maximum darkening.
   */
  getSkyDarkening(): number {
    return this.intensity * 0.35;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private choosePrecipitation(wx: number, wz: number): WeatherState {
    if (!this.biomeMap) return WeatherState.RAIN;

    const biome = this.biomeMap.getBiome(wx, wz);
    switch (biome) {
      case Biome.DESERT:
        return WeatherState.CLEAR; // no rain in desert
      case Biome.TUNDRA:
      case Biome.TAIGA:
        return WeatherState.SNOW;
      case Biome.OCEAN:
      case Biome.BEACH:
      case Biome.PLAINS:
      case Biome.FOREST:
      case Biome.JUNGLE:
      case Biome.SWAMP:
      case Biome.MOUNTAINS:
      default:
        return WeatherState.RAIN;
    }
  }

  private initParticles(px: number, py: number, pz: number): void {
    if (!this.positions || !this.velocities) return;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.respawnParticle(i, px, py, pz);
      // Randomize initial Y so particles don't all start at the top
      this.positions[i * 3 + 1] = py - 5 + Math.random() * SPAWN_HEIGHT;
    }
  }

  private respawnParticle(i: number, px: number, py: number, pz: number): void {
    if (!this.positions || !this.velocities) return;

    const i3 = i * 3;
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * SPAWN_RADIUS;

    this.positions[i3] = px + Math.cos(angle) * radius;
    this.positions[i3 + 1] = py + SPAWN_HEIGHT * (0.5 + Math.random() * 0.5);
    this.positions[i3 + 2] = pz + Math.sin(angle) * radius;

    // Snow gets horizontal drift, rain is mostly vertical
    const isSnow = this.state === WeatherState.SNOW || this.targetState === WeatherState.SNOW;
    if (isSnow) {
      this.velocities[i3] = (Math.random() - 0.5) * SNOW_DRIFT;
      this.velocities[i3 + 2] = (Math.random() - 0.5) * SNOW_DRIFT;
    } else {
      this.velocities[i3] = (Math.random() - 0.5) * 0.5;
      this.velocities[i3 + 2] = (Math.random() - 0.5) * 0.5;
    }
  }
}
