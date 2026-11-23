package along_harness.session

import along_harness.protocol.*

import std.collection.*
import stdx.encoding.json.*

func isOfficeTool(name: String): Bool {
    return name == "office_read_notes" || name == "office_analyze_tasks" || name == "office_create_artifacts"
}

func officeInt(v: JsonValue, min: Int64, max: Int64): Int64 {
    let n = integer(v, min)
    require(n <= max)
    return n
}

func officeText(v: JsonValue, min: Int64, max: Int64): String {
    let s = v.asString().getValue()
    require(s.size >= min && s.size <= max)
    return s
}

func officeKeyCount(o: JsonObject, required: Int64, optional: Array<String>): Unit {
    var count = required
    for (name in optional) {
        if (o.containsKey(name)) { count++ }
    }
    require(o.size() == count)
}

// At most two formats: 1 is Markdown, 2 is CSV, 3 is the pair.
func officeFormatCode(v: JsonValue): Int64 {
    let name = ref(v)
    if (name == "markdown") { return 1 }
    require(name == "csv")
    return 2
}

func officeUuid(v: JsonValue): String {
    let id = uuid(v)
    for (i in 0..id.size) {
        if (id[i] < b'A' || id[i] > b'F') { continue }
        let bytes = id.toArray()
        for (j in i..bytes.size) {
            if (bytes[j] >= b'A' && bytes[j] <= b'F') { bytes[j] += UInt8(32) }
        }
        return String.fromUtf8(bytes)
    }
    return id
}

func officeRefs(v: JsonValue): Unit {
    let items = v.asArray()
    require(items.size() >= 1 && items.size() <= 64)
    let seen = HashSet<String>()
    for (item in items.getItems()) { require(seen.add(officeUuid(item))) }
}

func officeOffset(args: JsonObject): Int64 {
    return if (args.containsKey("offset")) { officeInt(field(args, "offset"), 0, FRAME_LIMIT) } else { 0 }
}

func officeArguments(name: String, arguments: String): Option<JsonObject> {
    try {
        let args = JsonValue.fromStr(arguments).asObject()
        if (name == "office_read_notes") {
            officeKeyCount(args, 0, ["offset"])
            officeOffset(args)
        } else if (name == "office_analyze_tasks") {
            let action = ref(field(args, "action"))
            if (action == "page") {
                keys(args, ["action", "analysis_invocation_id", "after_record"])
                uuid(field(args, "analysis_invocation_id"))
                officeInt(field(args, "after_record"), 1, 4999)
            } else {
                require(action == "preview" || action == "analyze")
                keys(args, ["action"])
            }
        } else {
            officeKeyCount(args, 1, ["notes_invocation_ids", "analysis_invocation_id", "interpretation"])
            let formats = field(args, "formats").asArray()
            require(formats.size() >= 1 && formats.size() <= 2)
            var selected: Int64 = 0
            for (format in formats.getItems()) {
                let code = officeFormatCode(format)
                require(selected != code)
                selected += code
            }
            let notes = args.containsKey("notes_invocation_ids")
            let analysis = args.containsKey("analysis_invocation_id")
            require((notes || analysis) && (selected == 1 || analysis))
            if (notes) { officeRefs(field(args, "notes_invocation_ids")) }
            if (analysis) { uuid(field(args, "analysis_invocation_id")) }
            if (args.containsKey("interpretation")) {
                require(notes && selected != 2)
                officeText(field(args, "interpretation"), 0, 8192)
            }
        }
        return Some(args)
    } catch (_: Exception) {
        return None
    }
}

func officeSourceCheck(v: JsonValue): Unit {
    let source = v.asObject()
    keys(source, ["display_name", "version"])
    officeText(field(source, "display_name"), 1, 512)
    hash(field(source, "version"))
}

func officeNotesCheck(page: JsonObject): Unit {
    keys(page, ["kind", "source", "offset", "start_line", "end_line", "total_lines", "content", "next_offset"])
    officeSourceCheck(field(page, "source"))
    let offset = officeInt(field(page, "offset"), 0, FRAME_LIMIT)
    let start = officeInt(field(page, "start_line"), 1, FRAME_LIMIT + 1)
    let end = officeInt(field(page, "end_line"), start, FRAME_LIMIT + 1)
    let total = officeInt(field(page, "total_lines"), end, FRAME_LIMIT + 1)
    let size = officeText(field(page, "content"), 0, 4096).size
    require(offset + size <= FRAME_LIMIT && (offset != 0 || start == 1))
    require(size > 0 || (offset == 0 && total == 1))
    let next = field(page, "next_offset")
    if (isNull(next)) { require(end == total) }
    else { require(integer(next, offset + 1) == offset + size && offset + size < FRAME_LIMIT) }
}

func officeCountsCheck(v: JsonValue): Int64 {
    let counts = v.asObject()
    keys(counts, ["total", "todo", "in_progress", "done", "canceled", "overdue", "anomaly_rows", "missing_owner", "missing_due_date", "invalid_due_date", "invalid_status"])
    let total = officeInt(field(counts, "total"), 0, 5000)
    let open = officeInt(field(counts, "todo"), 0, total) + officeInt(field(counts, "in_progress"), 0, total)
    let closed = officeInt(field(counts, "done"), 0, total) + officeInt(field(counts, "canceled"), 0, total)
    let anomalies = officeInt(field(counts, "anomaly_rows"), 0, total)
    let missingOwner = officeInt(field(counts, "missing_owner"), 0, anomalies)
    let missingDue = officeInt(field(counts, "missing_due_date"), 0, anomalies)
    let invalidDue = officeInt(field(counts, "invalid_due_date"), 0, anomalies - missingDue)
    let invalidStatus = officeInt(field(counts, "invalid_status"), 0, anomalies)
    officeInt(field(counts, "overdue"), 0, open)
    require(open + closed + invalidStatus == total && anomalies <= missingOwner + missingDue + invalidDue + invalidStatus)
    return total
}

func officeEnumList(v: JsonValue, min: Int64, allowed: Array<String>): Unit {
    let items = v.asArray()
    require(items.size() >= min && items.size() <= allowed.size)
    let values = items.getItems()
    for (i in 0..values.size) {
        let value = ref(values[i])
        var found = false
        for (candidate in allowed) {
            if (candidate == value) { found = true; break }
        }
        require(found)
        for (j in 0..i) { require(ref(values[j]) != value) }
    }
}

func officePreviewCheck(v: JsonValue): Unit {
    let result = v.asObject()
    if (field(result, "valid").asBool().getValue()) {
        keys(result, ["valid", "total_records"])
        officeInt(field(result, "total_records"), 0, 5000)
        return
    }
    keys(result, ["valid", "issue", "template"])
    require(str(field(result, "template"), 38) == "task_id,title,owner,due_date,status\r\n")
    let issue = field(result, "issue").asObject()
    officeKeyCount(issue, 1, ["record_number", "column_number", "missing_columns"])
    let code = ref(field(issue, "code"))
    require(code == "invalid_utf8" || code == "input_byte_limit" || code == "missing_header" ||
        code == "empty_header" || code == "duplicate_header" || code == "missing_columns" ||
        code == "unexpected_column" || code == "malformed_csv" || code == "record_width" ||
        code == "column_limit" || code == "record_limit" || code == "field_byte_limit" ||
        code == "empty_task_id" || code == "duplicate_task_id")
    if (issue.containsKey("record_number")) { officeInt(field(issue, "record_number"), 0, 5001) }
    if (issue.containsKey("column_number")) { officeInt(field(issue, "column_number"), 1, 33) }
    require(issue.containsKey("missing_columns") == (code == "missing_columns"))
    if (code == "missing_columns") {
        officeEnumList(field(issue, "missing_columns"), 1, ["task_id", "title", "owner", "due_date", "status"])
    }
}

func officeAnalysisCheck(page: JsonObject): Unit {
    officeSourceCheck(field(page, "source"))
    let action = ref(field(page, "action"))
    if (action == "preview") {
        keys(page, ["kind", "action", "source", "result"])
        officePreviewCheck(field(page, "result"))
        return
    }
    require(action == "analyze" || action == "page")
    keys(page, ["kind", "action", "source", "as_of", "after_record", "total_records", "total_groups", "totals", "groups", "records", "next_after_record"])
    let date = officeText(field(page, "as_of"), 10, 10)
    require(date[0..4] != "0000")
    utcCheck(text(date + "T00:00:00Z"))
    let offset = if (action == "analyze") { officeInt(field(page, "after_record"), 0, 0) } else {
        officeInt(field(page, "after_record"), 1, 4999)
    }
    let total = officeInt(field(page, "total_records"), offset, 5000)
    let groupTotal = officeInt(field(page, "total_groups"), if (total == 0) { 0 } else { 1 }, total)
    require(officeCountsCheck(field(page, "totals")) == total)
    let records = field(page, "records").asArray()
    let end = offset + records.size()
    require(records.size() <= 5 && end <= total && (total == 0 || records.size() > 0))
    let next = field(page, "next_after_record")
    if (end == total) { require(isNull(next)) } else { officeInt(next, end, end) }
    let groups = field(page, "groups").asArray()
    let groupEnd = if (end < groupTotal) { end } else { groupTotal }
    require(groups.size() == (if (groupEnd > offset) { groupEnd - offset } else { 0 }))
    for (value in groups.getItems()) {
        let group = value.asObject()
        keys(group, ["owner", "owner_truncated", "totals"])
        let owner = field(group, "owner")
        let truncated = field(group, "owner_truncated").asBool().getValue()
        if (isNull(owner)) { require(!truncated) } else { officeText(owner, 1, 192) }
        let count = officeCountsCheck(field(group, "totals"))
        require(count > 0 && count <= total)
    }
    var recordNo = offset
    for (value in records.getItems()) {
        recordNo++
        let record = value.asObject()
        keys(record, ["record_number", "task_id", "title", "owner", "due_date", "status", "overdue", "anomalies", "truncated_fields"])
        officeInt(field(record, "record_number"), recordNo, recordNo)
        officeText(field(record, "task_id"), 1, 192)
        for (name in ["title", "owner", "due_date", "status"]) { officeText(field(record, name), 0, 192) }
        field(record, "overdue").asBool()
        officeEnumList(field(record, "anomalies"), 0, ["missing_owner", "missing_due_date", "invalid_due_date", "invalid_status"])
        officeEnumList(field(record, "truncated_fields"), 0, ["task_id", "title", "owner", "due_date", "status"])
    }
}

func officeArtifactsCheck(payload: JsonObject): Unit {
    keys(payload, ["kind", "artifacts"])
    let artifacts = field(payload, "artifacts").asArray()
    require(artifacts.size() >= 1 && artifacts.size() <= 2)
    var previousId = ""
    var previousFormat: Int64 = 0
    for (value in artifacts.getItems()) {
        let artifact = value.asObject()
        keys(artifact, ["artifact_id", "format", "filename", "size_bytes"])
        let id = officeUuid(field(artifact, "artifact_id"))
        let format = officeFormatCode(field(artifact, "format"))
        require(id != previousId && format != previousFormat)
        previousId = id
        previousFormat = format
        officeText(field(artifact, "filename"), 1, 512)
        officeInt(field(artifact, "size_bytes"), 1, 2 * FRAME_LIMIT)
    }
}

func officeResultMatches(name: String, args: JsonObject, result: JsonObject): Unit {
    if (ref(field(result, "status")) != "ok") { return }
    let payload = field(result, "result").asObject()
    if (name == "office_read_notes") {
        require(integer(field(payload, "offset"), 0) == officeOffset(args))
    } else if (name == "office_analyze_tasks") {
        let requested = ref(field(args, "action"))
        let received = ref(field(payload, "action"))
        require(requested == received || (requested == "analyze" && received == "preview" &&
            !field(field(payload, "result").asObject(), "valid").asBool().getValue()))
        if (requested == "page") {
            require(integer(field(payload, "after_record"), 1) == integer(field(args, "after_record"), 1))
        }
    } else {
        let requested = field(args, "formats").asArray()
        let artifacts = field(payload, "artifacts").asArray()
        var expected: Int64 = 0
        var actual: Int64 = 0
        for (format in requested.getItems()) { expected += officeFormatCode(format) }
        for (artifact in artifacts.getItems()) { actual += officeFormatCode(field(artifact.asObject(), "format")) }
        require(expected == actual)
    }
}

// The ledger-decoded and retained snapshots may serialize object keys in different orders.
func officeWireEqual(left: JsonValue, right: JsonValue): Bool {
    match (left.kind()) {
        case JsObject =>
            let fields = left.asObject().getFields()
            let other = right.asObject()
            if (fields.size != other.size()) { return false }
            for ((name, value) in fields) {
                if (!other.containsKey(name) || !officeWireEqual(value, field(other, name))) { return false }
            }
            return true
        case JsArray =>
            let a = left.asArray().getItems()
            let b = right.asArray().getItems()
            if (a.size != b.size) { return false }
            for (i in 0..a.size) {
                if (!officeWireEqual(a[i], b[i])) { return false }
            }
            return true
        case JsString => return left.asString().getValue() == right.asString().getValue()
        case JsBool => return left.asBool().getValue() == right.asBool().getValue()
        case JsNull => return isNull(right)
        case _ => return left.asFloat().getValue() == right.asFloat().getValue()
    }
}

func officeEntriesCheck(entries: JsonArray, observation: JsonObject, toolId: String): Unit {
    require(entries.size() == 2)
    let assistant = entries.get(0).getOrThrow().asObject()
    keys(assistant, ["role", "content", "tool_calls"])
    require(ref(field(assistant, "role")) == "assistant")
    str(field(assistant, "content"), FRAME_LIMIT)
    let calls = field(assistant, "tool_calls").asArray()
    require(calls.size() == 1)
    let call = calls.get(0).getOrThrow().asObject()
    keys(call, ["id", "type", "function"])
    require(ref(field(call, "type")) == "function")
    let function = field(call, "function").asObject()
    keys(function, ["name", "arguments"])
    require(ref(field(function, "name")) == toolId)
    let args = officeArguments(toolId, str(field(function, "arguments"), FRAME_LIMIT)).getOrThrow()
    let entry = entries.get(1).getOrThrow().asObject()
    keys(entry, ["role", "tool_call_id", "content"])
    require(ref(field(entry, "role")) == "tool" && ref(field(entry, "tool_call_id")) == ref(field(call, "id")))
    require(officeWireEqual(observation, JsonValue.fromStr(str(field(entry, "content"), FRAME_LIMIT))))
    officeResultMatches(toolId, args, field(observation, "result").asObject())
}
