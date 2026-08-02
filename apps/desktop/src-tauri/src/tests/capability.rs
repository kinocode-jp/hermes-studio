use std::{
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use crate::capability::{clear_optional_state, lock_until, BoundedLockError};

#[test]
fn proof_gate_wait_is_bounded_and_short_queue_contention_can_recover() {
    let gate = std::sync::Arc::new(Mutex::new(()));
    let held = gate.lock().expect("hold proof gate");
    let started = Instant::now();
    assert!(matches!(
        lock_until(&gate, started + Duration::from_millis(100)),
        Err(BoundedLockError::TimedOut),
    ));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "proof gate wait exceeded its absolute deadline",
    );
    drop(held);

    let queued_gate = gate.clone();
    let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
    let holder = thread::spawn(move || {
        let _held = queued_gate.lock().expect("hold queued proof gate");
        ready_sender.send(()).expect("announce held proof gate");
        thread::sleep(Duration::from_millis(50));
    });
    ready_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("queued proof gate is held");
    let recovered = lock_until(&gate, Instant::now() + Duration::from_secs(2));
    assert!(recovered.is_ok(), "short proof queue contention should recover");
    drop(recovered);
    holder.join().expect("queued proof holder exits");
}

#[test]
fn invalidation_clears_capability_even_after_state_lock_poisoning() {
    let state = std::sync::Arc::new(Mutex::new(Some("capability".to_owned())));
    let poisoned_state = state.clone();
    let poisoner = thread::spawn(move || {
        let _held = poisoned_state.lock().expect("hold capability state");
        panic!("poison capability state");
    });
    assert!(poisoner.join().is_err());

    clear_optional_state(&state);
    let value = match state.lock() {
        Ok(value) => value,
        Err(poisoned) => poisoned.into_inner(),
    };
    assert!(value.is_none());
}
