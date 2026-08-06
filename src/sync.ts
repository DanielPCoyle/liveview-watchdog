import { captureError } from './telemetry';
import { loadRegistry, saveRegistry, type Registry } from './feeds';

/**
 * Where the wall's shared state lives.
 *
 * Two real drivers behind one interface — the same shape, and the same
 * reasoning, as the DB facade in the RentRedi take-home:
 *
 *   local     localStorage. The default, so the app runs with zero setup and
 *             the tests stay hermetic.
 *   firebase  Realtime Database. Opt-in, and the reason this exists: a video
 *             wall is not a single-operator tool. If one operator acknowledges
 *             a dead camera or files an escalation, everyone else watching the
 *             same wall needs to see it — otherwise two people work the same
 *             incident and a third assumes somebody has it.
 *
 * This is the one abstraction here that earns its keep: there are genuinely two
 * implementations, not an interface speculatively wrapping one.
 *
 * The Firebase SDK is loaded with `import()` inside the driver, so a build with
 * no Firebase config never downloads it.
 */

export type SyncMode = 'local' | 'firebase';

export interface SyncDriver {
  mode: SyncMode;
  /** Current registry, and a subscription to changes made by anyone else. */
  subscribe: (onChange: (r: Registry) => void) => () => void;
  publish: (r: Registry) => void;
}

const FB = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

/** A database URL is the only field the RTDB client genuinely cannot infer. */
export function firebaseConfigured() {
  return Boolean(FB.databaseURL && FB.apiKey);
}

function localDriver(): SyncDriver {
  return {
    mode: 'local',
    subscribe(onChange) {
      onChange(loadRegistry());
      // Another tab is the closest thing to another operator that localStorage
      // can offer, and it costs one listener to honour it.
      const onStorage = (e: StorageEvent) => { if (e.key?.includes('registry')) onChange(loadRegistry()); };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    },
    publish: saveRegistry,
  };
}

/**
 * RTDB driver. Writes replace the whole registry node, which is correct for
 * this shape of data — the registry is small, and a wall whose feed list is
 * half one operator's edit and half another's is worse than last-write-wins.
 */
async function firebaseDriver(): Promise<SyncDriver> {
  const [{ initializeApp }, { getDatabase, ref, onValue, set }] = await Promise.all([
    import('firebase/app'),
    import('firebase/database'),
  ]);
  const app = initializeApp({
    apiKey: FB.apiKey,
    databaseURL: FB.databaseURL,
    projectId: FB.projectId,
    appId: FB.appId,
  });
  const node = ref(getDatabase(app), 'wall/registry');

  return {
    mode: 'firebase',
    subscribe(onChange) {
      return onValue(
        node,
        (snap) => {
          const value = snap.val() as Registry | null;
          // An empty node on first run means "nobody has seeded this wall yet",
          // not "the wall is empty" — fall back to local rather than wiping the
          // grid for everyone.
          onChange(value && Array.isArray(value.groups) && value.groups.length ? value : loadRegistry());
        },
        (err) => captureError(err, { where: 'rtdb.subscribe' }),
      );
    },
    publish(r) {
      // Keep a local copy regardless: if RTDB is unreachable the operator still
      // gets their own wall back on reload instead of a blank one.
      saveRegistry(r);
      void set(node, r).catch((err) => captureError(err, { where: 'rtdb.publish' }));
    },
  };
}

/**
 * Resolve the driver. Falls back to local on any Firebase failure — a shared
 * wall that cannot reach its backend must degrade to a working private wall,
 * never to a blank screen.
 */
export async function createSync(): Promise<SyncDriver> {
  if (!firebaseConfigured()) return localDriver();
  try {
    return await firebaseDriver();
  } catch (err) {
    captureError(err, { where: 'rtdb.init' });
    return localDriver();
  }
}
