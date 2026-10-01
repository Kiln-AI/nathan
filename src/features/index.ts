import type { AnyFeature } from "../core/feature";
import { prManagement } from "./pr_management";

/** Every feature Nathan knows about. Adding a feature means adding it here; config enables it. */
export const features: readonly AnyFeature[] = [prManagement];
