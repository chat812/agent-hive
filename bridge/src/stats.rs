use serde_json::{json, Value};
use sysinfo::{Disks, System};

pub fn collect() -> Value {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    // CPU: need a refresh cycle for accurate reading
    // Use global_cpu_usage which returns average across all cores
    let cpu_pct = sys.global_cpu_usage();

    let ram_free = sys.available_memory(); // bytes

    // Disk: sum available space across all disks
    let disks = Disks::new_with_refreshed_list();
    let disk_free: u64 = disks.iter().map(|d| d.available_space()).sum();

    json!({
        "type": "system_stats",
        "cpu_pct": cpu_pct,
        "ram_free": ram_free,
        "disk_free": disk_free
    })
}
