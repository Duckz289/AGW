import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planGeneratedTest } from "../../src/testgen/generator.ts";
import { renderGeneratedTest } from "../../src/testgen/render.ts";
import { rtExceptionScenario } from "../helpers/testgen-scenarios.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, "__fixtures__", "testgen-golden.spec.ts");

/**
 * Same fixed RT-EXCEPTION scenario as testgen-render.test.ts, planned and
 * rendered, compared byte-for-byte against a checked-in fixture.
 */
describe("testgen golden fixture", () => {
  it("matches tests/unit/__fixtures__/testgen-golden.spec.ts exactly", async () => {
    const scenario = rtExceptionScenario();
    const outcome = planGeneratedTest({ ...scenario, findingId: "finding-0001" });
    expect(outcome.status).toBe("planned");
    if (outcome.status !== "planned") return;

    const source = renderGeneratedTest(outcome.plan);
    const golden = await fs.readFile(GOLDEN_PATH, "utf-8");
    expect(source).toBe(golden);
  });
});
