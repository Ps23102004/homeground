// ============================================================================
// The player model: a stylized longboard with a rider that leans into carves.
// Local space is built along +X (the board's forward), Y up, +Z to its right,
// so the Game can drop the board's basis straight into a rotation matrix.
// ============================================================================

import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from "three";

export interface RiderMesh {
  /** Add this to the scene; the Game drives its transform. */
  root: Group;
  /** Rolls with the carve — the body leans, the deck stays on its wheels. */
  body: Group;
  /** Spun by wheel speed. */
  wheels: Group[];
}

export function createRiderMesh(): RiderMesh {
  const root = new Group();

  const deckMat = new MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.7, metalness: 0.05 });
  const gripMat = new MeshStandardMaterial({ color: 0x14161c, roughness: 0.95 });
  const wheelMat = new MeshStandardMaterial({ color: 0xf2b134, roughness: 0.5 });
  const truckMat = new MeshStandardMaterial({ color: 0x9aa3b0, roughness: 0.35, metalness: 0.6 });
  const skinMat = new MeshStandardMaterial({ color: 0xe8b58c, roughness: 0.85 });
  const shirtMat = new MeshStandardMaterial({ color: 0xe4572e, roughness: 0.8 });
  const jeansMat = new MeshStandardMaterial({ color: 0x3d5a80, roughness: 0.85 });

  const deck = new Mesh(new BoxGeometry(1.15, 0.045, 0.26), deckMat);
  deck.position.y = 0.09;
  deck.castShadow = true;
  root.add(deck);

  const grip = new Mesh(new BoxGeometry(1.1, 0.008, 0.24), gripMat);
  grip.position.y = 0.115;
  root.add(grip);

  const wheelGeo = new CylinderGeometry(0.035, 0.035, 0.05, 10);
  const wheels: Group[] = [];
  for (const wx of [-0.38, 0.38]) {
    const truck = new Mesh(new BoxGeometry(0.06, 0.05, 0.2), truckMat);
    truck.position.set(wx, 0.055, 0);
    root.add(truck);
    for (const wz of [-0.115, 0.115]) {
      const g = new Group();
      const w = new Mesh(wheelGeo, wheelMat);
      w.rotation.x = Math.PI / 2; // cylinder axis along Z = the axle
      g.add(w);
      g.position.set(wx, 0.035, wz);
      root.add(g);
      wheels.push(g);
    }
  }

  // Rider, standing across the deck (feet apart along +X, facing +X).
  const body = new Group();
  body.position.y = 0.115;
  root.add(body);

  const legL = new Mesh(new CapsuleGeometry(0.055, 0.36, 3, 8), jeansMat);
  legL.position.set(-0.2, 0.26, -0.06);
  legL.rotation.z = 0.22;
  body.add(legL);
  const legR = new Mesh(new CapsuleGeometry(0.055, 0.36, 3, 8), jeansMat);
  legR.position.set(0.22, 0.26, 0.06);
  legR.rotation.z = -0.18;
  body.add(legR);

  const torso = new Mesh(new CapsuleGeometry(0.1, 0.3, 3, 10), shirtMat);
  torso.position.set(0.05, 0.62, 0);
  torso.rotation.z = -0.25; // crouched forward over the nose
  torso.castShadow = true;
  body.add(torso);

  const head = new Mesh(new SphereGeometry(0.085, 12, 10), skinMat);
  head.position.set(0.17, 0.86, 0);
  body.add(head);

  const armL = new Mesh(new CapsuleGeometry(0.04, 0.28, 3, 8), skinMat);
  armL.position.set(0.16, 0.66, -0.16);
  armL.rotation.set(0.5, 0, -1.15);
  body.add(armL);
  const armR = new Mesh(new CapsuleGeometry(0.04, 0.28, 3, 8), skinMat);
  armR.position.set(-0.06, 0.66, 0.18);
  armR.rotation.set(-0.5, 0, 0.9);
  body.add(armR);

  return { root, body, wheels };
}
