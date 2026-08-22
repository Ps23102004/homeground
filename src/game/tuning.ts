// ============================================================================
// Homeground — THE CALIBRATION LAYER
//
// Every number that decides how the board FEELS lives here and nowhere else.
// Mutate TUNING at runtime (a debug panel, the console) and the next physics
// step picks it up — nothing caches these.
//
// Units: meters, seconds, radians. "rate" values are per-second exponential
// easing rates: a value of 10 means "gets ~63% of the way there in 100ms".
// ============================================================================

export const TUNING = {
  // ---- integrator -------------------------------------------------------
  /** m/s^2. Deliberately above real 9.81 — game gravity. Lower = floaty moon
   *  jumps and lazy downhill accel; higher = snappy drops, harsher landings. */
  gravity: 20,
  /** s. Fixed physics substep. Smaller is more stable on steep/spiky terrain. */
  fixedStep: 1 / 120,
  /** Max substeps consumed per frame, so an alt-tab stall can't spiral. */
  maxSubsteps: 8,
  /** m/s. Hard clamp. Nothing physical, just refuses to let a bug hit warp. */
  maxSpeed: 34,

  // ---- rider body -------------------------------------------------------
  /** m. Horizontal collision radius used against building walls. */
  riderRadius: 0.5,
  /**
   * m. Deck height above the TERRAIN sample (wheels + trucks). The visible
   * road surface is drawn SURFACE_LIFT (0.12 m) above the same terrain so the
   * ground stops poking through it, so this has to clear that too or the
   * wheels sink into the tarmac.
   */
  rideHeight: 0.26,
  /**
   * m/s. You start already rolling. Physically you'd start still, but most
   * addresses on earth are flat: on a 1% street the board never moves without
   * input, and someone opening a shared link sees a parked longboard and
   * quits. One kick's worth of speed is enough to make the first second read
   * as motion. Raise it and a steep spawn feels like a cannon.
   */
  spawnSpeed: 4.5,

  // ---- rolling resistance ----------------------------------------------
  /** 1/s. Linear drag on asphalt. Dominates at low speed; raise it and gentle
   *  suburban grades stop being rideable, lower it and you never slow down. */
  rollingFriction: 0.08,
  /** 1/s ADDED to rollingFriction when off the road ribbon. Grass must punish
   *  enough that the road is obviously the fun line, without being a wall. */
  offroadFriction: 1.1,
  /** Quadratic drag coefficient (1/m). This sets terminal speed together with
   *  the grade: v_terminal solves rolling*v + airDrag*v^2 = g*sin(slope). */
  airDrag: 0.0032,
  /** Multiplier on airDrag while tucking (shift). Tuck = reward for commitment. */
  tuckDragScale: 0.55,
  /** m/s^2 against the velocity while footbraking. */
  brakeDecel: 14,
  /** m/s. Below this we clamp to a dead stop so the board doesn't jitter. */
  minRollSpeed: 0.25,

  // ---- steering / carving ----------------------------------------------
  /** rad/s of yaw at full steer and low speed. The headline "how twitchy". */
  maxTurnRate: 2.5,
  /** Turn rate is divided by (1 + this * speed). Bigger = much wider arcs when
   *  you're fast, which is what makes speed feel committing. */
  turnSpeedFalloff: 0.075,
  /** m/s. Below this the board barely rotates — no pivoting on the spot. */
  minTurnSpeed: 0.6,
  /** rate. How fast raw input eases into actual steer. Low = languid carves. */
  steerResponse: 9,
  /** rate at which sideways velocity is scrubbed. High = railed, low = slidey. */
  grip: 14,
  /** m/s at which grip starts falling off — the drift threshold. */
  driftSpeed: 15,
  /** Grip multiplier floor at high speed + full steer. Lower = big slides. */
  driftGripFloor: 0.3,
  /** Extra grip loss multiplier while braking (footbrake slides the tail). */
  brakeGripScale: 0.55,
  /** rad of visual body/deck lean at full carve. Pure feel, no physics. */
  leanMax: 0.6,
  /** rate the lean angle eases. Slower than steer, so the body trails the board. */
  leanResponse: 7,

  // ---- pump / push ------------------------------------------------------
  /** m/s^2 while pumping mid-carve. This is the honest answer to "my street is
   *  flat" — a real longboarder generates speed by carving, so you can too. */
  pumpPower: 8,
  /** Fraction of pumpPower available when going dead straight (no carve). */
  pumpStraightFloor: 0.15,
  /** m/s. Pump authority fades linearly to zero here. */
  pumpMaxSpeed: 17,
  /** m/s added by one foot push (tap pump while roughly straight). */
  pushImpulse: 3.4,
  /** s between pushes — the cadence of a real push. */
  pushCooldown: 0.45,
  /** m/s above which your foot can't keep up and pushing does nothing. */
  pushMaxSpeed: 11,

  // ---- air & landing ----------------------------------------------------
  /** Fraction of gravity a crest has to beat before you leave the ground.
   *  1.0 is the honest physical threshold (v^2 * curvature > g). Below 1 you
   *  pop off crests earlier — needed in practice because SRTM-class elevation
   *  data is ~30 m/post and smooths away most of the sharp edges a real street
   *  has (driveway lips, curb cuts, humpback bridges). Lower = more air. */
  launchEase: 0.35,
  /** Steering authority multiplier in the air. Spin for style, not for control. */
  airSteer: 0.35,
  /** rad. Heading-vs-velocity mismatch on touchdown above which you eat it. */
  landStickAngle: 0.6,
  /** m/s of into-the-slope velocity that your knees can't absorb. */
  landBailSpeed: 14,
  /** Fraction of impact speed returned as bounce. Keep tiny — 0.3 is a trampoline. */
  landAbsorb: 0.05,
  /** s of degraded control after a bail. */
  bailTime: 1.1,
  /** Speed multiplier applied the instant you bail. */
  bailSpeedKeep: 0.35,
  /** Steering authority multiplier while bailed out. */
  bailSteerScale: 0.25,

  // ---- buildings --------------------------------------------------------
  /** 1/s of tangential drag WHILE touching a building. A rate, not a per-step
   *  multiplier — a ~1 s continuous scrape costs you about half your speed.
   *  Raise it and walls end runs; drop it to 0 and buildings are ice. */
  wallFriction: 0.7,
  /** Fraction of into-wall speed reflected. Bouncy buildings feel awful; keep low. */
  wallBounce: 0.08,
  /** rate the board's heading is yanked to align with velocity while scraping. */
  wallAlign: 11,

  // ---- camera (most of what makes speed feel like speed) ---------------
  /** m behind the rider at a standstill. */
  camDistance: 7,
  /** Extra m of pullback per m/s of speed. The single best "fast" cue. */
  camDistancePerSpeed: 0.16,
  camDistanceMax: 15,
  /** m above the contact point. */
  camHeight: 2.9,
  /** Spring constant. Higher = camera welded to the rider (twitchy on bumps). */
  camStiffness: 62,
  /** 1.0 = critically damped. <1 overshoots (whippy), >1 sluggish and safe. */
  camDamping: 1.05,
  /** m ahead of the rider the camera aims. Bigger = you see the run, not the
   *  deck. At 7 the lens tipped down far enough that the bottom third of every
   *  frame was empty tarmac; 11 trades that for the street you are about to
   *  ride, which is both better looking and more useful. */
  camLookAhead: 11,
  camLookHeight: 1.65,
  /** rate the camera yaw chases the board yaw. LOW ON PURPOSE: the lag is what
   *  lets you watch your own carve instead of riding a rigid rail. */
  camYawLag: 6,
  /** Multiplier from board lean (rad) to camera roll (rad) — at leanMax 0.6
   *  that is about 10 degrees at full carve. Small on purpose; big values
   *  induce motion sickness. */
  camRoll: 0.3,
  /** m of vertical camera buzz at maxSpeed while grounded. This is the whole
   *  "breathe": a spring camera on smooth interpolated terrain is otherwise
   *  perfectly still at 70 km/h, and stillness reads as slow no matter what the
   *  speedometer says. Two detuned sines so it never pulses. Keep it under
   *  ~5 cm — beyond that it stops being road buzz and becomes a handheld shot. */
  camBuzz: 0.035,
  /** deg FOV at a standstill. */
  camFovBase: 62,
  /** deg of extra FOV per m/s. */
  camFovPerSpeed: 0.72,
  camFovMax: 92,
  /** Extra deg while tucking. */
  camFovTuckBonus: 6,
  /** rate the FOV eases. Deliberately slow so the rush builds instead of popping. */
  camFovResponse: 3.5,
  /** m the camera stays above the terrain, so it never clips into a hill. */
  camMinClearance: 0.9,

  // ---- the reveal -------------------------------------------------------
  /** s of drone-shot arrival before the chase camera takes over. Long enough
   *  to read the neighbourhood, short enough that nobody reaches for a skip. */
  introSeconds: 2.6,
  /** m above the rider the drone starts. This is a NEIGHBOURHOOD shot or it is
   *  nothing: at 34 m you frame one intersection and two lawns, which is worse
   *  than the ground view it is replacing. 105 m puts a dozen blocks and the
   *  hill they sit on in frame. */
  introHeight: 98,
  /** m behind the rider the drone starts. Height and distance together set the
   *  pitch, and the pitch is what decides whether the shot reads as a PLACE or
   *  as a map: 62 m gave a 58-degree look-down, which is a site plan. 128 m
   *  puts it near 37 degrees, so the hill, the skyline and the haze behind them
   *  are all in frame and the blocks have sides you can see. */
  introDistance: 128,
  /** rad the drone is swung off the rider's heading at t=0, so the arrival is
   *  an arc rather than a lift — an arc gives parallax, a lift gives none. */
  introSwingRadians: 0.85,
  /** deg FOV at the top of the drone shot. Long lens: it is what makes a real
   *  city read as a model, and it is the whole reason for the tilt-shift. */
  introFov: 34,

  // ---- input ------------------------------------------------------------
  /** Fraction of screen width on each edge that acts as a lean zone on touch. */
  touchSteerZone: 0.4,
};

export type Tuning = typeof TUNING;
