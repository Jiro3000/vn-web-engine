// Whole-binary static native inventory exporter for SiglusEngine executables.
// Read-only: never mutates, renames, saves, or executes target code.
//
// Arguments:
//   args[0] = output JSON path (created atomically via temp file + move)
//   args[1] = binary id (e.g. "anemoi")
//   args[2] = expected analyzed SHA-256 (lowercase hex, or "-" to skip check)
//   args[3] = outer container SHA-256
//   args[4] = PE FileVersion string (or "null")
//   args[5] = containerKind ("direct-pe" | "sdwrap-embedded-pe" | "packed-pe")
//   args[6] = embeddedPeOffset (e.g. "0x1c000" or "null")
//   args[7] = outer file size in bytes

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.block.BasicBlockModel;
import ghidra.program.model.block.CodeBlock;
import ghidra.program.model.block.CodeBlockIterator;
import ghidra.program.model.block.CodeBlockReference;
import ghidra.program.model.block.CodeBlockReferenceIterator;
import ghidra.program.model.data.DataType;
import ghidra.program.model.lang.OperandType;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.FlowType;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolTable;

import com.google.gson.stream.JsonWriter;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

public class SiglusWholeBinaryInventory extends GhidraScript {

    private static final int MAX_STRINGS_PER_FN = 64;
    private static final int MAX_STRING_LEN = 120;
    private static final int MAX_CONSTANTS_PER_FN = 64;

    private static final Set<String> THIRD_PARTY_MARKERS = Set.of(
        "libpng", "png_create", "ihdr", "idat", "iend", "zlib", "inflate ", "deflate ",
        "vorbis", "theora", "oggs", "jfif", "libjpeg", "jpeg_create", "huffman",
        "quantization table", "bogus marker", "incorrect header check", "invalid block type",
        "too many length or distance symbols", "invalid stored block lengths",
        "not a png file", "png unsigned integer out of range"
    );

    private static final Set<String> SIGLUS_STRING_HINTS = Set.of(
        "gameexe", "scene.pck", "siglus", "mwnd", "waku", "excall", "selbtn",
        "syscom", "objbtngroup", "frame_action", "cgtable", "tonecurve", "namae",
        "chrkoe", "flick_scene", "joypad", "msgbk", "gan", "g00", "omv", "ovk", "owp",
        "dbs", "nwa", "screen_size", "start_scene", "menu_scene", "save_scene",
        "load_scene", "config_scene", "cancel_scene", "quick_save", "inner_save",
        "end_save", "object.cnt", "mwnd.cnt", "waku.cnt", "flag.cnt", "counter.cnt"
    );

    private static final Set<String> CRT_NAME_PREFIXES = Set.of(
        "__eh_", "_eh_", "__seh_", "_seh_", "__security_", "@__security_",
        "__alloca", "_alloca", "__chkstk", "_chkstk", "__ftol", "_ftol",
        "__allmul", "__alldiv", "__allrem", "__aulldiv", "__aullrem",
        "__allshl", "__allshr", "__aullshr", "__dtoui", "__ultod",
        "___tmaincrtstartup", "_winmaincrtstartup", "_crt", "__crt",
        "_atexit", "__onexit", "_malloc", "_free", "_realloc", "_calloc",
        "_memcpy", "_memmove", "_memset", "_memcmp", "_strlen", "_strcmp",
        "_wcslen", "_wcscmp", "_wcscpy", "__invalid_parameter", "_purecall",
        "__cxxthrowexception", "__cxxframehandler", "std::", "??0", "??1", "??2", "??3"
    );

    private static String hexAddr(long value) {
        return "0x" + Long.toUnsignedString(value, 16);
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return toHex(md.digest(data));
    }

    private static String sha256Utf8(String text) throws Exception {
        return sha256Hex(text.getBytes(StandardCharsets.UTF_8));
    }

    private static String toHex(byte[] bytes) {
        char[] hex = new char[bytes.length * 2];
        final char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            int b = bytes[i] & 0xff;
            hex[i * 2] = digits[b >>> 4];
            hex[i * 2 + 1] = digits[b & 0xf];
        }
        return new String(hex);
    }

    private static String mnemonicClass(String m) {
        String u = m.toUpperCase(Locale.ROOT);
        if (u.startsWith("MOV") || u.equals("LEA") || u.equals("XCHG") || u.startsWith("CMOV") || u.startsWith("SET")) return "DATA";
        if (u.equals("PUSH") || u.equals("POP") || u.equals("LEAVE") || u.equals("ENTER")) return "STACK";
        if (u.equals("CALL")) return "CALL";
        if (u.startsWith("RET")) return "RET";
        if (u.equals("JMP")) return "JMP";
        if (u.startsWith("J")) return "JCC";
        if (u.equals("CMP") || u.equals("TEST")) return "CMP";
        if (u.equals("ADD") || u.equals("SUB") || u.equals("INC") || u.equals("DEC") || u.equals("ADC") || u.equals("SBB")
            || u.equals("IMUL") || u.equals("MUL") || u.equals("IDIV") || u.equals("DIV") || u.equals("NEG") || u.equals("CDQ")) return "ARITH";
        if (u.equals("AND") || u.equals("OR") || u.equals("XOR") || u.equals("NOT")
            || u.startsWith("SH") || u.startsWith("SA") || u.startsWith("RO") || u.startsWith("BT")) return "BIT";
        if (u.startsWith("F") || u.contains("SS") || u.contains("SD") || u.contains("PS") || u.contains("PD") || u.startsWith("CVT")) return "FP";
        if (u.startsWith("REP") || u.startsWith("STOS") || u.startsWith("MOVS") || u.startsWith("SCAS") || u.startsWith("CMPS")) return "STR";
        return "OTHER";
    }

    private boolean isImageAddress(long value, long minImg, long maxImg) {
        return Long.compareUnsigned(value, minImg) >= 0 && Long.compareUnsigned(value, maxImg) <= 0;
    }

    private String readStringAt(Memory memory, Listing listing, Address addr, Map<Long, String> cache) {
        long key = addr.getOffset();
        if (cache.containsKey(key)) return cache.get(key);
        String result = null;
        try {
            Data d = listing.getDefinedDataAt(addr);
            if (d != null && d.hasStringValue()) {
                Object val = d.getValue();
                if (val != null) {
                    result = cleanString(val.toString());
                }
            }
            if (result == null) {
                MemoryBlock blk = memory.getBlock(addr);
                if (blk != null && blk.isInitialized() && !blk.isExecute()) {
                    // Try UTF-16LE heuristic first (Siglus uses extensive wide strings), then ASCII.
                    byte[] buf = new byte[Math.min(256, (int) Math.min(256L, blk.getEnd().subtract(addr) + 1))];
                    int n = memory.getBytes(addr, buf);
                    result = tryDecodeUtf16Le(buf, n);
                    if (result == null) {
                        result = tryDecodeAscii(buf, n);
                    }
                }
            }
        } catch (Exception ignored) {
            result = null;
        }
        cache.put(key, result);
        return result;
    }

    private static String cleanString(String raw) {
        if (raw == null) return null;
        String s = raw.replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t").trim();
        if (s.length() < 2) return null;
        if (s.length() > MAX_STRING_LEN) s = s.substring(0, MAX_STRING_LEN);
        return s;
    }

    private static String tryDecodeUtf16Le(byte[] buf, int n) {
        if (n < 6) return null;
        StringBuilder sb = new StringBuilder();
        int printable = 0;
        for (int i = 0; i + 1 < n; i += 2) {
            int ch = (buf[i] & 0xff) | ((buf[i + 1] & 0xff) << 8);
            if (ch == 0) break;
            if ((ch >= 0x20 && ch <= 0x7e) || (ch >= 0x3000 && ch <= 0x9fff) || (ch >= 0xff00 && ch <= 0xffef)) {
                sb.append((char) ch);
                printable++;
            } else {
                return null;
            }
            if (sb.length() >= MAX_STRING_LEN) break;
        }
        if (printable >= 3) return cleanString(sb.toString());
        return null;
    }

    private static String tryDecodeAscii(byte[] buf, int n) {
        if (n < 4) return null;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            int b = buf[i] & 0xff;
            if (b == 0) break;
            if (b >= 0x20 && b <= 0x7e) {
                sb.append((char) b);
            } else {
                return null;
            }
            if (sb.length() >= MAX_STRING_LEN) break;
        }
        if (sb.length() >= 4) return cleanString(sb.toString());
        return null;
    }

    private static boolean isStackBaseRegister(String text) {
        return text.contains("EBP") || text.contains("ESP") || text.contains("RBP") || text.contains("RSP");
    }

    private static String classifyBucket(
        Function fn,
        int insnCount,
        int byteLength,
        Set<String> imports,
        Set<String> strings,
        List<Long> callees,
        List<Map<String, Object>> switches,
        Map<String, Boolean> sectionExecInfo
    ) {
        String nameLower = fn.getName(true).toLowerCase(Locale.ROOT);
        if (fn.isThunk() || fn.isExternal()) {
            return "thunk";
        }
        if (insnCount <= 2 && byteLength <= 10) {
            if (!imports.isEmpty() || callees.size() == 1) {
                return "thunk";
            }
        }
        for (String pref : CRT_NAME_PREFIXES) {
            if (nameLower.startsWith(pref) || nameLower.contains("::" + pref)) {
                return "crt_stl";
            }
        }
        for (String s : strings) {
            String sl = s.toLowerCase(Locale.ROOT);
            for (String marker : THIRD_PARTY_MARKERS) {
                if (sl.contains(marker)) {
                    return "third_party_codec";
                }
            }
        }
        for (String s : strings) {
            String sl = s.toLowerCase(Locale.ROOT);
            if (sl.contains("microsoft visual c++") || sl.contains("runtime error!")
                || sl.contains("pure virtual function call") || sl.contains("r6002")
                || sl.contains("r6025") || sl.contains("cor_exit_process")
                || sl.contains("bad allocation") || sl.contains("string too long")
                || sl.contains("vector<t> too long") || sl.contains("invalid map/set<t>")) {
                return "crt_stl";
            }
        }
        // Thin Win32/DirectX wrapper: calls imports directly, tiny body, no switches, no Siglus strings
        boolean hasSiglusStr = false;
        for (String s : strings) {
            String sl = s.toLowerCase(Locale.ROOT);
            for (String hint : SIGLUS_STRING_HINTS) {
                if (sl.contains(hint)) {
                    hasSiglusStr = true;
                    break;
                }
            }
            if (hasSiglusStr) break;
        }
        if (!hasSiglusStr && switches.isEmpty() && !imports.isEmpty() && callees.isEmpty() && insnCount <= 25) {
            return "win32_directx_wrapper";
        }
        if (hasSiglusStr || !switches.isEmpty()) {
            return "engine_candidate";
        }
        if (insnCount >= 6) {
            return "engine_candidate";
        }
        return "unclassified";
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 8) {
            throw new IllegalArgumentException(
                "Expected 8 args: outputPath binaryId expectedAnalyzedSha256 outerSha256 fileVersion containerKind embeddedPeOffset outerSize"
            );
        }
        Path outputPath = Path.of(args[0]).toAbsolutePath();
        String binaryId = args[1];
        String expectedAnalyzedSha256 = args[2];
        String outerSha256 = args[3];
        String fileVersion = "null".equals(args[4]) ? null : args[4];
        String containerKind = args[5];
        String embeddedPeOffset = "null".equals(args[6]) ? null : args[6];
        long outerSize = Long.parseLong(args[7]);

        String actualSha256 = currentProgram.getExecutableSHA256();
        if (actualSha256 != null) actualSha256 = actualSha256.toLowerCase(Locale.ROOT);
        if (!"-".equals(expectedAnalyzedSha256) && !expectedAnalyzedSha256.equalsIgnoreCase(actualSha256)) {
            throw new IllegalStateException(
                "Program executableSha256 mismatch for " + binaryId
                + ": expected=" + expectedAnalyzedSha256 + " actual=" + actualSha256
            );
        }

        Memory memory = currentProgram.getMemory();
        Listing listing = currentProgram.getListing();
        FunctionManager fm = currentProgram.getFunctionManager();
        ReferenceManager rm = currentProgram.getReferenceManager();
        BasicBlockModel bbm = new BasicBlockModel(currentProgram);

        long imageBase = currentProgram.getImageBase().getOffset();
        long minImg = currentProgram.getMinAddress().getOffset();
        long maxImg = currentProgram.getMaxAddress().getOffset();

        // Build map of IAT/external thunk addresses -> DLL::ImportName
        Map<Long, String> importTargetMap = new HashMap<>();
        SymbolTable st = currentProgram.getSymbolTable();
        for (Symbol sym : st.getExternalSymbols()) {
            String ns = sym.getParentNamespace() != null ? sym.getParentNamespace().getName() : "EXTERNAL";
            String fullName = ns + "::" + sym.getName();
            for (Reference ref : rm.getReferencesTo(sym.getAddress())) {
                importTargetMap.put(ref.getFromAddress().getOffset(), fullName);
            }
        }
        // Also map thunk functions pointing to external functions
        for (Function f : fm.getFunctions(true)) {
            if (f.isThunk()) {
                Function target = f.getThunkedFunction(true);
                if (target != null && target.isExternal()) {
                    String ns = target.getParentNamespace() != null ? target.getParentNamespace().getName() : "EXTERNAL";
                    importTargetMap.put(f.getEntryPoint().getOffset(), ns + "::" + target.getName());
                }
            }
        }

        // Collect all functions in deterministic address order
        List<Function> allFunctions = new ArrayList<>();
        FunctionIterator fi = fm.getFunctions(true);
        while (fi.hasNext()) {
            monitor.checkCancelled();
            Function f = fi.next();
            if (!f.isExternal()) {
                allFunctions.add(f);
            }
        }
        allFunctions.sort(Comparator.comparingLong(f -> f.getEntryPoint().getOffset()));

        // Pre-index function entry addresses for fast caller/callee resolution
        Set<Long> fnEntries = new HashSet<>(allFunctions.size() * 2);
        for (Function f : allFunctions) {
            fnEntries.add(f.getEntryPoint().getOffset());
        }

        Map<Long, String> stringCache = new HashMap<>();
        Map<String, Integer> bucketCounts = new TreeMap<>();
        long totalIndirectCallSites = 0;
        long totalSwitchTables = 0;

        Path parent = outputPath.getParent();
        if (parent != null) Files.createDirectories(parent);
        Path tempPath = outputPath.resolveSibling(outputPath.getFileName().toString() + ".tmp");

        try (JsonWriter w = new JsonWriter(new BufferedWriter(
            new OutputStreamWriter(new FileOutputStream(tempPath.toFile()), StandardCharsets.UTF_8), 1 << 20))) {

            w.beginObject();
            w.name("schema").value("siglus-native-inventory/v1");
            w.name("capturedAt").value(Instant.now().toString());

            w.name("exporter").beginObject();
            w.name("name").value("SiglusWholeBinaryInventory");
            w.name("version").value("1.0.0");
            w.name("ghidraVersion").value(ghidra.framework.Application.getApplicationVersion());
            w.endObject();

            w.name("binary").beginObject();
            w.name("id").value(binaryId);
            w.name("programPath").value(currentProgram.getDomainFile().getPathname());
            w.name("sha256").value(outerSha256);
            w.name("analyzedSha256").value(actualSha256 != null ? actualSha256 : expectedAnalyzedSha256);
            if (fileVersion == null) w.name("fileVersion").nullValue();
            else w.name("fileVersion").value(fileVersion);
            w.name("containerKind").value(containerKind);
            if (embeddedPeOffset == null) w.name("embeddedPeOffset").nullValue();
            else w.name("embeddedPeOffset").value(embeddedPeOffset);
            w.name("imageBase").value(hexAddr(imageBase));
            w.name("size").value(outerSize);
            w.name("languageId").value(currentProgram.getLanguageID().getIdAsString());
            w.name("compilerSpecId").value(currentProgram.getCompilerSpec().getCompilerSpecID().getIdAsString());

            w.name("sections").beginArray();
            for (MemoryBlock blk : memory.getBlocks()) {
                w.beginObject();
                w.name("name").value(blk.getName());
                w.name("start").value(hexAddr(blk.getStart().getOffset()));
                w.name("end").value(hexAddr(blk.getEnd().getOffset()));
                w.name("size").value(blk.getSize());
                w.name("execute").value(blk.isExecute());
                w.name("write").value(blk.isWrite());
                w.name("initialized").value(blk.isInitialized());
                w.endObject();
            }
            w.endArray();
            w.endObject(); // binary

            // We'll write functions array first, then summary at the end
            w.name("functions").beginArray();

            for (int idx = 0; idx < allFunctions.size(); idx++) {
                monitor.checkCancelled();
                Function fn = allFunctions.get(idx);
                long entryVa = fn.getEntryPoint().getOffset();
                long entryRva = entryVa - imageBase;
                AddressSetView body = fn.getBody();

                // 1. Body ranges & raw bytes SHA-256
                MessageDigest rawMd = MessageDigest.getInstance("SHA-256");
                List<long[]> ranges = new ArrayList<>();
                long totalByteLen = 0;
                byte[] chunkBuf = new byte[65536];
                for (AddressRange range : body.getAddressRanges(true)) {
                    long rs = range.getMinAddress().getOffset();
                    long re = range.getMaxAddress().getOffset();
                    long rlen = range.getLength();
                    ranges.add(new long[]{rs, re, rlen});
                    totalByteLen += rlen;
                    long remaining = rlen;
                    Address cur = range.getMinAddress();
                    while (remaining > 0) {
                        int toRead = (int) Math.min(remaining, chunkBuf.length);
                        try {
                            int got = memory.getBytes(cur, chunkBuf, 0, toRead);
                            if (got > 0) {
                                rawMd.update(chunkBuf, 0, got);
                            } else {
                                byte[] zeros = new byte[toRead];
                                rawMd.update(zeros);
                            }
                        } catch (Exception e) {
                            byte[] zeros = new byte[toRead];
                            rawMd.update(zeros);
                        }
                        cur = cur.add(toRead);
                        remaining -= toRead;
                    }
                }
                String rawBytesSha256 = toHex(rawMd.digest());

                // 2. Callers
                TreeSet<Long> callers = new TreeSet<>();
                ReferenceIterator toRefs = rm.getReferencesTo(fn.getEntryPoint());
                while (toRefs.hasNext()) {
                    Reference ref = toRefs.next();
                    RefType rt = ref.getReferenceType();
                    if (rt.isCall() || rt.isJump()) {
                        Function callerFn = fm.getFunctionContaining(ref.getFromAddress());
                        if (callerFn != null && !callerFn.isExternal()) {
                            long cva = callerFn.getEntryPoint().getOffset();
                            if (cva != entryVa) callers.add(cva);
                        }
                    }
                }

                // 3. Instructions: constant-preserving normalization, callees, indirect calls, strings, imports, switches
                StringBuilder normSb = new StringBuilder(Math.min(65536, (int) (totalByteLen * 4)));
                TreeSet<Long> callees = new TreeSet<>();
                TreeSet<String> importXrefs = new TreeSet<>();
                TreeSet<String> stringXrefs = new TreeSet<>();
                TreeSet<Long> semanticConstants = new TreeSet<>();
                List<Map<String, Object>> indirectCallSites = new ArrayList<>();
                List<Map<String, Object>> switchTables = new ArrayList<>();
                int insnCount = 0;

                InstructionIterator insns = listing.getInstructions(body, true);
                while (insns.hasNext()) {
                    Instruction ins = insns.next();
                    insnCount++;
                    String mnem = ins.getMnemonicString();
                    FlowType flow = ins.getFlowType();

                    // Build normalized instruction token preserving semantic constants
                    normSb.append(mnem);
                    boolean isStackAdjust = (mnem.equalsIgnoreCase("SUB") || mnem.equalsIgnoreCase("ADD"))
                        && ins.getNumOperands() == 2
                        && ("ESP".equalsIgnoreCase(ins.getDefaultOperandRepresentation(0))
                            || "RSP".equalsIgnoreCase(ins.getDefaultOperandRepresentation(0)));

                    for (int op = 0; op < ins.getNumOperands(); op++) {
                        normSb.append('|');
                        int opType = ins.getOperandType(op);
                        String rep = ins.getDefaultOperandRepresentation(op);
                        Reference[] opRefs = ins.getOperandReferences(op);
                        boolean hasMemOrCodeRef = false;
                        boolean isImportRef = false;
                        for (Reference r : opRefs) {
                            long toOff = r.getToAddress().getOffset();
                            if (importTargetMap.containsKey(toOff)) {
                                isImportRef = true;
                                hasMemOrCodeRef = true;
                            } else if (r.getToAddress().isMemoryAddress() && isImageAddress(toOff, minImg, maxImg)) {
                                hasMemOrCodeRef = true;
                            }
                        }

                        if (isImportRef) {
                            // Preserve exact Win32/import symbol identity in normalized hash
                            String impName = null;
                            for (Reference r : opRefs) {
                                impName = importTargetMap.get(r.getToAddress().getOffset());
                                if (impName != null) break;
                            }
                            normSb.append("IMP:").append(impName);
                        } else if (flow.isCall() || flow.isJump()) {
                            if ((opType & OperandType.ADDRESS) != 0 && !flow.isComputed()) {
                                Address[] flows = ins.getFlows();
                                if (flows.length > 0 && body.contains(flows[0])) {
                                    normSb.append("TGT_LOCAL");
                                } else {
                                    normSb.append("TGT_EXT");
                                }
                            } else if ((opType & OperandType.REGISTER) != 0) {
                                normSb.append("IND_REG");
                            } else {
                                normSb.append("IND_MEM");
                            }
                        } else if (isStackAdjust && op == 1) {
                            normSb.append("FRAME_SZ");
                        } else if (hasMemOrCodeRef) {
                            // Relocatable data/code reference inside image
                            if (rep.contains("[") && (rep.contains("+") || rep.contains("*"))) {
                                normSb.append("REL_INDEXED");
                            } else {
                                normSb.append("REL_ADDR");
                            }
                        } else if ((opType & OperandType.REGISTER) != 0 && !rep.contains("[")) {
                            normSb.append("REG:").append(rep);
                        } else if (rep.contains("[")) {
                            // Memory operand: distinguish stack-frame locals vs struct field offsets
                            if (isStackBaseRegister(rep)) {
                                // Keep parameter vs local polarity, normalize volatile local offset
                                if (rep.contains("-")) normSb.append("MEM_LOCAL");
                                else if (rep.contains("EBP") || rep.contains("RBP")) normSb.append("MEM_PARAM");
                                else normSb.append("MEM_STACK");
                            } else {
                                // Struct/object dereference: preserve register-class & field offset shape
                                // Note: normalize any embedded image address inside indexed expr
                                String normMem = rep.replaceAll("0x[0-9a-fA-F]{6,8}", "<IMG_ADDR>");
                                normSb.append("MEM:").append(normMem);
                            }
                        } else if ((opType & OperandType.SCALAR) != 0) {
                            Scalar sc = ins.getScalar(op);
                            if (sc != null) {
                                long sv = sc.getSignedValue();
                                long uv = sc.getUnsignedValue();
                                // If scalar falls inside PE image range AND is >= 0x400000, treat as relocatable address
                                if (isImageAddress(uv, minImg, maxImg) && uv >= 0x400000L) {
                                    normSb.append("REL_IMM");
                                } else {
                                    // Preserve meaningful semantic immediate!
                                    normSb.append("IMM:").append(sv);
                                    if (semanticConstants.size() < MAX_CONSTANTS_PER_FN) {
                                        // Track non-trivial constants (skip 0/1/-1 noise or keep small switch/enum constants)
                                        if (sv != 0 && sv != 1 && sv != -1) {
                                            semanticConstants.add(sv);
                                        }
                                    }
                                }
                            } else {
                                normSb.append("SCALAR");
                            }
                        } else {
                            normSb.append("OP:").append(opType);
                        }
                    }
                    normSb.append('\n');

                    // Inspect references from this instruction
                    Reference[] fromRefs = ins.getReferencesFrom();
                    boolean handledImportCall = false;
                    for (Reference ref : fromRefs) {
                        Address toAddr = ref.getToAddress();
                        long toOff = toAddr.getOffset();
                        RefType rt = ref.getReferenceType();

                        String imp = importTargetMap.get(toOff);
                        if (imp != null) {
                            importXrefs.add(imp);
                            if (rt.isCall() || rt.isJump()) handledImportCall = true;
                            continue;
                        }
                        if (toAddr.isExternalAddress()) {
                            Symbol extSym = st.getPrimarySymbol(toAddr);
                            if (extSym != null) {
                                String ns = extSym.getParentNamespace() != null ? extSym.getParentNamespace().getName() : "EXTERNAL";
                                importXrefs.add(ns + "::" + extSym.getName());
                                if (rt.isCall() || rt.isJump()) handledImportCall = true;
                            }
                            continue;
                        }
                        if (rt.isCall() || (rt.isJump() && !body.contains(toAddr))) {
                            Function calleeFn = fm.getFunctionAt(toAddr);
                            if (calleeFn != null) {
                                if (calleeFn.isExternal()) {
                                    String ns = calleeFn.getParentNamespace() != null ? calleeFn.getParentNamespace().getName() : "EXTERNAL";
                                    importXrefs.add(ns + "::" + calleeFn.getName());
                                    handledImportCall = true;
                                } else {
                                    long cva = calleeFn.getEntryPoint().getOffset();
                                    if (cva != entryVa) callees.add(cva);
                                    // If callee is an IAT thunk, also record the import!
                                    String thunkImp = importTargetMap.get(cva);
                                    if (thunkImp != null) {
                                        importXrefs.add(thunkImp);
                                        handledImportCall = true;
                                    }
                                }
                            }
                        } else if (rt.isData() || rt.isRead() || rt == RefType.PARAM) {
                            if (stringXrefs.size() < MAX_STRINGS_PER_FN && isImageAddress(toOff, minImg, maxImg)) {
                                String str = readStringAt(memory, listing, toAddr, stringCache);
                                if (str != null) stringXrefs.add(str);
                            }
                            // Detect function pointer reference (data ref pointing to an executable function entry)
                            if (fnEntries.contains(toOff) && toOff != entryVa && !rt.isFlow()) {
                                Map<String, Object> site = new LinkedHashMap<>();
                                site.put("siteVa", hexAddr(ins.getAddress().getOffset()));
                                site.put("mnemonic", mnem);
                                site.put("kind", "fn-ptr-ref");
                                site.put("targetVa", hexAddr(toOff));
                                indirectCallSites.add(site);
                            }
                        }
                    }

                    // Detect computed calls & switch tables vs unresolved indirect jumps
                    if (flow.isComputed()) {
                        Address[] flows = ins.getFlows();
                        if (flow.isCall()) {
                            if (!handledImportCall) {
                                Map<String, Object> site = new LinkedHashMap<>();
                                site.put("siteVa", hexAddr(ins.getAddress().getOffset()));
                                site.put("mnemonic", mnem);
                                site.put("kind", "indirect-call");
                                site.put("operand", ins.getNumOperands() > 0 ? ins.getDefaultOperandRepresentation(0) : "");
                                indirectCallSites.add(site);
                            }
                        } else if (flow.isJump()) {
                            if (flows.length >= 2) {
                                // Switch jump table!
                                TreeSet<Long> uniqueTargets = new TreeSet<>();
                                for (Address t : flows) uniqueTargets.add(t.getOffset());
                                Map<String, Object> sw = new LinkedHashMap<>();
                                sw.put("jumpVa", hexAddr(ins.getAddress().getOffset()));
                                sw.put("caseCount", flows.length);
                                sw.put("uniqueTargetCount", uniqueTargets.size());
                                switchTables.add(sw);
                            } else if (!handledImportCall) {
                                Map<String, Object> site = new LinkedHashMap<>();
                                site.put("siteVa", hexAddr(ins.getAddress().getOffset()));
                                site.put("mnemonic", mnem);
                                site.put("kind", "indirect-jump");
                                site.put("operand", ins.getNumOperands() > 0 ? ins.getDefaultOperandRepresentation(0) : "");
                                indirectCallSites.add(site);
                            }
                        }
                    }
                }

                String normalizedInsnSha256 = sha256Utf8(normSb.toString());

                // 4. CFG shape hash (basic blocks + out-edges + mnemonic classes)
                StringBuilder cfgSb = new StringBuilder();
                int blockCount = 0;
                Map<Long, Integer> blockIds = new HashMap<>();
                List<CodeBlock> blocks = new ArrayList<>();
                CodeBlockIterator cbi = bbm.getCodeBlocksContaining(body, monitor);
                while (cbi.hasNext()) {
                    CodeBlock cb = cbi.next();
                    blocks.add(cb);
                }
                blocks.sort(Comparator.comparingLong(b -> b.getFirstStartAddress().getOffset()));
                for (int bi = 0; bi < blocks.size(); bi++) {
                    blockIds.put(blocks.get(bi).getFirstStartAddress().getOffset(), bi);
                }
                blockCount = blocks.size();
                for (int bi = 0; bi < blocks.size(); bi++) {
                    CodeBlock cb = blocks.get(bi);
                    cfgSb.append("B").append(bi).append(':');
                    // Mnemonic-class summary for block
                    InstructionIterator bins = listing.getInstructions(cb, true);
                    int bInsns = 0;
                    while (bins.hasNext()) {
                        Instruction ins = bins.next();
                        bInsns++;
                        cfgSb.append(mnemonicClass(ins.getMnemonicString())).append(',');
                    }
                    cfgSb.append("|N=").append(bInsns).append("|E=");
                    List<String> edges = new ArrayList<>();
                    CodeBlockReferenceIterator dests = cb.getDestinations(monitor);
                    while (dests.hasNext()) {
                        CodeBlockReference d = dests.next();
                        Integer targetId = blockIds.get(d.getDestinationAddress().getOffset());
                        edges.add(d.getFlowType().getName() + "->" + (targetId != null ? "B" + targetId : "EXT"));
                    }
                    Collections.sort(edges);
                    for (String e : edges) cfgSb.append(e).append(';');
                    cfgSb.append('\n');
                }
                String cfgShapeSha256 = sha256Utf8(cfgSb.toString());

                // 5. Coarse deterministic classification
                List<Long> calleeList = new ArrayList<>(callees);
                String bucket = classifyBucket(fn, insnCount, (int) totalByteLen, importXrefs, stringXrefs, calleeList, switchTables, null);
                bucketCounts.merge(bucket, 1, Integer::sum);
                totalIndirectCallSites += indirectCallSites.size();
                totalSwitchTables += switchTables.size();

                // 6. Emit function JSON object
                w.beginObject();
                w.name("rva").value(hexAddr(entryRva));
                w.name("va").value(hexAddr(entryVa));
                w.name("name").value(fn.getName(true));
                w.name("isThunk").value(fn.isThunk());
                if (fn.isThunk()) {
                    Function t = fn.getThunkedFunction(true);
                    if (t != null && !t.isExternal()) {
                        w.name("thunkTargetVa").value(hexAddr(t.getEntryPoint().getOffset()));
                    }
                }
                w.name("bucket").value(bucket);
                w.name("bodyRanges").beginArray();
                for (long[] r : ranges) {
                    w.beginObject();
                    w.name("start").value(hexAddr(r[0]));
                    w.name("end").value(hexAddr(r[1]));
                    w.name("byteLength").value(r[2]);
                    w.endObject();
                }
                w.endArray();
                w.name("byteLength").value(totalByteLen);
                w.name("insnCount").value(insnCount);
                w.name("blockCount").value(blockCount);
                w.name("rawBytesSha256").value(rawBytesSha256);
                w.name("normalizedInsnSha256").value(normalizedInsnSha256);
                w.name("cfgShapeSha256").value(cfgShapeSha256);

                w.name("semanticConstants").beginArray();
                for (Long c : semanticConstants) w.value(c.longValue());
                w.endArray();

                w.name("callers").beginArray();
                for (Long c : callers) w.value(hexAddr(c));
                w.endArray();

                w.name("callees").beginArray();
                for (Long c : callees) w.value(hexAddr(c));
                w.endArray();

                w.name("indirectCallSites").beginArray();
                for (Map<String, Object> site : indirectCallSites) {
                    w.beginObject();
                    for (Map.Entry<String, Object> e : site.entrySet()) {
                        w.name(e.getKey()).value(String.valueOf(e.getValue()));
                    }
                    w.endObject();
                }
                w.endArray();

                w.name("stringXrefs").beginArray();
                for (String s : stringXrefs) w.value(s);
                w.endArray();

                w.name("importXrefs").beginArray();
                for (String imp : importXrefs) w.value(imp);
                w.endArray();

                if (!switchTables.isEmpty()) {
                    w.name("switchTableInfo").beginArray();
                    for (Map<String, Object> sw : switchTables) {
                        w.beginObject();
                        w.name("jumpVa").value((String) sw.get("jumpVa"));
                        w.name("caseCount").value(((Number) sw.get("caseCount")).intValue());
                        w.name("uniqueTargetCount").value(((Number) sw.get("uniqueTargetCount")).intValue());
                        w.endObject();
                    }
                    w.endArray();
                }

                w.endObject();
            }
            w.endArray(); // functions

            w.name("summary").beginObject();
            w.name("discoveredFunctionCount").value(allFunctions.size());
            w.name("exportedFunctionCount").value(allFunctions.size());
            w.name("totalIndirectCallSites").value(totalIndirectCallSites);
            w.name("totalSwitchTables").value(totalSwitchTables);
            w.name("bucketCounts").beginObject();
            for (Map.Entry<String, Integer> e : bucketCounts.entrySet()) {
                w.name(e.getKey()).value(e.getValue());
            }
            w.endObject();
            w.endObject();

            w.endObject();
        }

        Files.move(tempPath, outputPath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        println("SIGLUS_INVENTORY_OK binary=" + binaryId + " functions=" + allFunctions.size() + " output=" + outputPath);
    }
}
