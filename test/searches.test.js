import assert from "node:assert/strict";
import { test } from "node:test";
import { districtOfPostal, filtersFromPropertyGuru, newestFirst, searchesFromTemplate } from "../src/searches.js";
import { checkProject } from "../src/projects.js";

// The search the example project shipped with, built by hand on PropertyGuru.
const HAND_BUILT = "https://www.propertyguru.com.sg/property-for-rent?listingType=rent&isCommercial=false&minPrice=2500&maxPrice=3500&bedrooms=0&bedrooms=1&bedrooms=2&entireUnitOrRoom=ent&districtCode=D01&districtCode=D02&districtCode=D03&districtCode=D04&districtCode=D05&districtCode=D08&districtCode=D09&districtCode=D10&districtCode=D11&districtCode=D12&sort=date&order=desc";

const filters = { minPrice: 2500, maxPrice: 3500, bedrooms: [0, 1, 2], wholeUnit: true, districts: ["D01", "D02", "D03", "D04", "D05", "D08", "D09", "D10", "D11", "D12"] };

test("the template rebuilds the hand-made PropertyGuru search exactly", () => {
  const [pg] = searchesFromTemplate(filters, { sites: ["propertyguru"] });
  assert.equal(pg.url, HAND_BUILT);
});

test("a PropertyGuru search reads back into the same filters", () => {
  assert.deepEqual(filtersFromPropertyGuru(HAND_BUILT), filters);
});

test("one template gives one search per site, ready for a project", () => {
  const searches = searchesFromTemplate(filters);
  assert.deepEqual(searches.map((s) => s.site), ["propertyguru", "99co", "carousell"]);
  assert.deepEqual(searches.map((s) => s.id), ["main-propertyguru", "main-99co", "main-carousell"]);
  assert.match(searches[0].title, /^PropertyGuru · whole unit, studio\/1BR\/2BR, S\$2.5k–3.5k, 10 districts$/);
  assert.ok(searches.every((s) => s.active && s.template === "main"));
  const project = JSON.parse(JSON.stringify({ id: "t", title: "T", budget: { min: 1, max: 2 }, criteria: [], searches }));
  assert.deepEqual(checkProject(project), []);
});

test("bad filters are refused with a reason", () => {
  assert.throws(() => searchesFromTemplate({ ...filters, minPrice: 4000 }), /min ≤ max/);
  assert.throws(() => searchesFromTemplate({ ...filters, districts: ["D99"] }), /D01–D28/);
});

// Set by hand on 99.co (price range, entire unit, studio/1/2 beds, newest), 26 Oct 2026.
const N99_BROWSER = "https://www.99.co/singapore/rent?main_category=all&name=Singapore&query_name=Singapore&property_segments=residential&price_range=2500%2C3600&rental_type=unit&rooms=0%2C1%2C2&sort_field=recency&sort_order=desc&page_size=36";

test("the 99.co search matches what 99.co's own filters produce", () => {
  const [, n99] = searchesFromTemplate({ ...filters, maxPrice: 3600 });
  assert.equal(n99.url, N99_BROWSER);
  // No district filter on 99.co: the extractor applies them within the same two-page limit.
  assert.deepEqual(n99.districts, filters.districts);
  assert.equal(n99.pages, 2);
});

test("postal codes map to districts", () => {
  assert.equal(districtOfPostal("328741"), "D12");
  assert.equal(districtOfPostal("12 Lorong Limau, 328741"), "D12");
  assert.equal(districtOfPostal("098633"), "D04");
  assert.equal(districtOfPostal("640176"), "D22");
  assert.equal(districtOfPostal("no code"), null);
});

test("a hand-made search URL is sorted newest first, keeping its filters", () => {
  assert.equal(
    newestFirst("https://www.propertyguru.com.sg/property-for-rent?listingType=rent&mrtStations=NS22&sort=price&order=asc"),
    "https://www.propertyguru.com.sg/property-for-rent?listingType=rent&mrtStations=NS22&sort=date&order=desc"
  );
  assert.equal(
    newestFirst("https://www.99.co/singapore/rent/hdb?price_range=2000%2C3000"),
    "https://www.99.co/singapore/rent/hdb?price_range=2000%2C3000&sort_field=recency&sort_order=desc"
  );
  // The address bar after setting filters carries the page; polls add their own.
  assert.equal(
    newestFirst("https://www.propertyguru.com.sg/property-for-sale?listingType=sale&page=1&isCommercial=false&minPrice=500000&maxPrice=800000&propertyTypeGroup=H&bedrooms=3"),
    "https://www.propertyguru.com.sg/property-for-sale?listingType=sale&isCommercial=false&minPrice=500000&maxPrice=800000&propertyTypeGroup=H&bedrooms=3&sort=date&order=desc"
  );
  assert.doesNotMatch(newestFirst("https://www.99.co/singapore/sale?price_range=1%2C2&page_num=3"), /page_num/);
});

test("the Carousell search uses its own filter names, newest first", () => {
  const [cx] = searchesFromTemplate({ minPrice: 3000, maxPrice: 4000, bedrooms: [0, 2], wholeUnit: true, districts: ["D09"] }, { sites: ["carousell"] });
  // Written by Carousell's own filter bar, Oct 2026.
  assert.equal(cx.url, "https://www.carousell.sg/categories/property-102/rent-in-singapore-229/?price_start=3000&price_end=4000&property_bedrooms=BEDROOMS_0_BEDROOMS_STUDIO%2CBEDROOMS_2_BEDROOMS&sort_by=3");
  assert.deepEqual(cx.districts, ["D09"]);
  assert.equal(newestFirst("https://www.carousell.sg/categories/property-102/rent-in-singapore-229/?sort_by=1"), "https://www.carousell.sg/categories/property-102/rent-in-singapore-229/?sort_by=3");
});
