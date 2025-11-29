const { google } = require("googleapis");

const IMPORT_SHEET_NAME = "Import";
const CONTROL_SHEET_NAME = "Feed Control List";

const CORE_TAGS = [
  "id",
  "code",
  "vendor_code",
  "title",
  "barcode",
  "category",
  "category_id",
  "brand",
  "availability",
  "weight",
  "height",
  "width",
  "length",
  "description"
];

const IMAGE_PREFIX = "image_";
const ROOT_TAG = "Market";

function escapeXml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function convertToCm(value, units) {
  if (value === null || value === undefined) return "";

  const str = String(value).replace(",", ".").trim();
  let num = parseFloat(str);
  if (isNaN(num)) {
    return value;
  }

  const u = (units || "").toString().toLowerCase().trim();

  if (u === "мм" || u === "mm") {
    num = num / 10;
  } else if (u === "см" || u === "cm") {
    // already cm
  } else if (u === "м" || u === "m") {
    num = num * 100;
  }

  num = Math.round(num * 100) / 100;
  return num.toString();
}

function isBooleanLike(val) {
  if (val === true || val === false) return true;
  const s = String(val).trim().toLowerCase();
  if (s === "true" || s === "false" || s === "1" || s === "0") return true;
  if (s === "так" || s === "ні" || s === "так" || s === "ні") return true;
  return false;
}

function booleanToUa(val) {
  if (val === true) return "Так";
  if (val === false) return "Ні";

  const s = String(val).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "так" || s === "так") return "Так";
  if (s === "false" || s === "0" || s === "ні" || s === "ні") return "Ні";

  return "";
}

function processTagParamValue(paramName, value, units) {
  if (value === null || value === undefined) return [];

  if (String(value).trim().toLowerCase() === "cellimage") return [];

  const result = [];

  if (isBooleanLike(value)) {
    const s = booleanToUa(value);
    if (s !== "") result.push(s);
    return result;
  }

  let valStr = String(value).trim();
  if (valStr === "") return [];

  if (units) {
    valStr = valStr + " " + String(units).trim();
  }

  if (paramName === "Особливості") {
    const parts = valStr.split(",");
    parts.forEach((p) => {
      const t = p.trim();
      if (t !== "") result.push(t);
    });
    return result;
  }

  result.push(valStr);
  return result;
}

async function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").replace(/\n/g, "\n");
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

  const auth = new google.auth.JWT(email, null, key, scopes);
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function getSheetValues(sheets, spreadsheetId, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });
  return res.data.values || [];
}

function buildControlMap(values) {
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const importField = row[0];
    const flag = row[1];
    const feedName = row[2];
    const tagName = row[3];
    const valSpec = row[4];
    const units = row[5];

    if (!importField) continue;

    const enabled =
      flag === true ||
      String(flag).toLowerCase() === "true" ||
      String(flag) === "1";

    const xmlName = feedName ? String(feedName).trim() : String(importField).trim();

    map[String(importField).trim()] = {
      enabled,
      xmlName,
      tagName: tagName ? String(tagName).trim() : "",
      units: units ? String(units).trim() : "",
      rawValues: valSpec
    };
  }
  return map;
}

function buildOffersXml(importValues, controlMap) {
  if (importValues.length < 2) {
    return [
      "<?xml version='1.0' encoding='UTF-8'?>",
      "<" + ROOT_TAG + ">",
      "  <offers/>",
      "</" + ROOT_TAG + ">"
].join("\n");
  }

  const headers = importValues[0];
  const rows = importValues.slice(1);

  const xml = [];
  xml.push("<?xml version='1.0' encoding='UTF-8'?>");
  xml.push("<" + ROOT_TAG + ">");
  xml.push("  <offers>");

  rows.forEach((row) => {
    if (!row || row.join("") === "") return;

    const offerLines = [];
    let codeLine = "";
    let titleLine = "";
    const pictureLines = [];
    const paramLines = [];

    headers.forEach((header, colIndex) => {
      if (!header) return;

      const value = row[colIndex];
      if (value === "" || value === null || value === undefined) return;

      const headerStr = String(header).trim();
      const control = controlMap[headerStr];
      if (!control || !control.enabled) return;

      const xmlName = control.xmlName;
      const tagName = control.tagName;
      const units = control.units;

      if (CORE_TAGS.indexOf(xmlName) !== -1) {
        let coreValue = value;

        if (xmlName === "description") {
          offerLines.push(
            "      <description><![CDATA[" +
              String(coreValue) +
              "]]></description>"
          );
          return;
        }

        if (xmlName === "height" || xmlName === "width" || xmlName === "length") {
          coreValue = convertToCm(coreValue, units);
        }

        if (xmlName === "code") {
          codeLine = "      <code>" + escapeXml(coreValue) + "</code>";
          return;
        }

        if (xmlName === "title") {
          titleLine = "      <title>" + escapeXml(coreValue) + "</title>";
          return;
        }

        offerLines.push(
          "      <" + xmlName + ">" + escapeXml(coreValue) + "</" + xmlName + ">"
        );
        return;
      }

      if (xmlName.indexOf(IMAGE_PREFIX) === 0) {
        pictureLines.push("        <picture>" + escapeXml(value) + "</picture>");
        return;
      }

      if (xmlName === "tags") {
        const paramName =
          tagName && String(tagName).trim() ? String(tagName).trim() : headerStr;

        const processed = processTagParamValue(paramName, value, units);
        if (!processed || processed.length === 0) return;

        processed.forEach((item) => {
          paramLines.push(
            "        <param name=\"" +
            escapeXml(paramName) +
      "\">" +
      escapeXml(item) +
      "</param>"
  );
        });

        return;
      }

      const paramNameDefault = xmlName;
      let valStr = String(value);

      if (units) {
        valStr = valStr + " " + String(units).trim();
      }

      if (valStr === "") return;

      paramLines.push(
        "        <param name=\"" +
          escapeXml(paramNameDefault) +
          "\">" +
          escapeXml(valStr) +
          "</param>"
      );
    });

    if (
      !codeLine &&
      !titleLine &&
      offerLines.length === 0 &&
      pictureLines.length === 0 &&
      paramLines.length === 0
    ) {
      return;
    }

    xml.push("    <offer>");
    if (codeLine) xml.push(codeLine);
    if (titleLine) xml.push(titleLine);

    offerLines.forEach((line) => xml.push(line));

    if (pictureLines.length > 0) {
      xml.push("      <image_link>");
      pictureLines.forEach((line) => xml.push(line));
      xml.push("      </image_link>");
    }

    if (paramLines.length > 0) {
      xml.push("      <tags>");
      paramLines.forEach((line) => xml.push(line));
      xml.push("      </tags>");
    }

    xml.push("    </offer>");
  });

  xml.push("  </offers>");
  xml.push("</" + ROOT_TAG + ">");

  return xml.join("\n");
}

let cachedXml = null; let cachedAt = 0; const CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 години

module.exports = async (req, res) => {
if (req.method !== "GET") {
res.status(405).send("Method Not Allowed");
return;
}
const now = Date.now();
if (cachedXml && now - cachedAt < CACHE_TTL_MS) {
res.setHeader("Content-Type", "application/xml; charset=utf-8");
res.status(200).send(cachedXml);
return;
}
try {
const spreadsheetId = process.env.SPREADSHEET_ID;
const sheets = await getSheetsClient();
const importValues = await getSheetValues(
  sheets,
  spreadsheetId,
  "'" + IMPORT_SHEET_NAME + "'"
);
const controlValues = await getSheetValues(
  sheets,
  spreadsheetId,
  "'" + CONTROL_SHEET_NAME + "'"
);

const controlMap = buildControlMap(controlValues);
const xml = buildOffersXml(importValues, controlMap);

cachedXml = xml;
cachedAt = now;

res.setHeader("Content-Type", "application/xml; charset=utf-8");
res.status(200).send(xml);
} catch (err) {
console.error(err);
res.status(500).send("Internal Server Error");
}
};
