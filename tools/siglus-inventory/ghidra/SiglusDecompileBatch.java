// Read-only headless Ghidra batch decompiler for targeted Phase 5 inspection.
// Writes raw decompiled C output to ignored local storage (never committed).
// Usage args: <outputTxtPath> <va1> <va2> ...

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;

import java.io.BufferedWriter;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public class SiglusDecompileBatch extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) throw new IllegalArgumentException("Usage: outputPath va1 [va2 ...]");
        Path outPath = Path.of(args[0]).toAbsolutePath();
        Files.createDirectories(outPath.getParent());

        FunctionManager fm = currentProgram.getFunctionManager();
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        try (PrintWriter out = new PrintWriter(new BufferedWriter(
            new OutputStreamWriter(new FileOutputStream(outPath.toFile()), StandardCharsets.UTF_8)))) {
            for (int i = 1; i < args.length; i++) {
                monitor.checkCancelled();
                Address addr = toAddr(args[i]);
                Function fn = fm.getFunctionAt(addr);
                if (fn == null) fn = fm.getFunctionContaining(addr);
                out.println("================================================================");
                if (fn == null) {
                    out.println("MISSING_FUNCTION: " + args[i]);
                    continue;
                }
                out.printf("FUNCTION %s (requested %s) name=%s bytes=%d%n",
                    fn.getEntryPoint(), args[i], fn.getName(true), fn.getBody().getNumAddresses());
                DecompileResults res = ifc.decompileFunction(fn, 60, monitor);
                if (res != null && res.decompileCompleted() && res.getDecompiledFunction() != null) {
                    out.println(res.getDecompiledFunction().getC());
                } else {
                    out.println("DECOMPILE_FAILED: " + (res != null ? res.getErrorMessage() : "null"));
                }
            }
        } finally {
            ifc.dispose();
        }
        println("SIGLUS_DECOMPILE_BATCH_OK count=" + (args.length - 1));
    }
}
