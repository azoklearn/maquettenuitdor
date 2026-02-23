(function () {
  'use strict';

  var form = document.getElementById('form-reservation');
  var inputArrivee = document.getElementById('date-arrivee');
  var inputDepart = document.getElementById('date-depart');
  var btnSubmit = document.getElementById('btn-submit');
  var recapBlock = document.getElementById('recap-prix');
  var fpArrivee, fpDepart;

  var API_BASE = '';

  function getBookedDates(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API_BASE + '/api/booked-dates', true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          callback(data.dates || []);
        } catch (e) {
          callback([]);
        }
      } else {
        callback([]);
      }
    };
    xhr.onerror = function () { callback([]); };
    xhr.send();
  }

  function disableDatesForFlatpickr(dates) {
    if (!dates || !dates.length) return [];
    return dates.map(function (d) { return d; });
  }

  function initCalendars(disabledDates) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var disableRule = disabledDates && disabledDates.length
      ? disabledDates
      : [];

    fpArrivee = flatpickr(inputArrivee, {
      locale: 'fr',
      dateFormat: 'd/m/Y',
      altInput: false,
      minDate: today,
      allowInput: false,
      disableMobile: true,
      disable: disableRule,
      onChange: function (selectedDates) {
        if (selectedDates[0] && fpDepart) {
          fpDepart.set('minDate', selectedDates[0]);
          if (fpDepart.selectedDates[0] && fpDepart.selectedDates[0] < selectedDates[0]) {
            fpDepart.setDate(selectedDates[0], false);
          }
        }
        updateRecap();
      }
    });

    fpDepart = flatpickr(inputDepart, {
      locale: 'fr',
      dateFormat: 'd/m/Y',
      minDate: today,
      allowInput: false,
      disableMobile: true,
      disable: disableRule,
      onChange: function () { updateRecap(); }
    });
  }

  var PACK_LABELS = { aucun: 'Sans pack', champagne: 'Champagne', romance: 'Romance', luxe: 'Luxe', evasion: 'Formule 80' };
  var PACK_PRICES = { aucun: 0, champagne: 45, romance: 75, luxe: 120, evasion: 80 };
  var BASE_PRICE = 150;

  function updateRecap() {
    if (!recapBlock || !fpArrivee || !fpDepart) return;
    var d1 = fpArrivee.selectedDates[0];
    var d2 = fpDepart.selectedDates[0];
    if (!d1 || !d2) {
      recapBlock.style.display = 'none';
      return;
    }
    var nights = Math.ceil((d2 - d1) / (24 * 60 * 60 * 1000));
    if (nights <= 0) {
      recapBlock.style.display = 'none';
      return;
    }
    var packInput = form && form.querySelector('input[name="pack"]:checked');
    var pack = packInput ? packInput.value : 'aucun';
    var packPrice = PACK_PRICES[pack] || 0;
    var total = nights * BASE_PRICE + packPrice;

    document.getElementById('recap-dates').textContent = d1.toLocaleDateString('fr-FR') + ' → ' + d2.toLocaleDateString('fr-FR') + ' (' + nights + ' nuit' + (nights > 1 ? 's' : '') + ')';
    document.getElementById('recap-pack').textContent = 'Pack : ' + (PACK_LABELS[pack] || pack) + (packPrice ? ' (+ ' + packPrice + ' €)' : '');
    document.getElementById('recap-total').textContent = 'Total : ' + total + ' €';
    recapBlock.style.display = 'block';
  }

  if (form) {
    form.addEventListener('change', function () {
      if (form.querySelector('input[name="pack"]')) updateRecap();
    });
  }

  if (typeof flatpickr === 'undefined') {
    if (inputArrivee && inputDepart) {
      inputArrivee.type = 'date';
      inputDepart.type = 'date';
      inputArrivee.removeAttribute('readonly');
      inputDepart.removeAttribute('readonly');
      var todayStr = new Date().toISOString().split('T')[0];
      inputArrivee.min = todayStr;
      inputDepart.min = todayStr;
      inputArrivee.addEventListener('change', function () {
        inputDepart.min = inputArrivee.value;
        if (inputDepart.value && inputDepart.value < inputArrivee.value) inputDepart.value = inputArrivee.value;
      });
    }
  } else {
    getBookedDates(function (dates) {
      initCalendars(dates);
    });
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!inputArrivee || !inputDepart) return;
      var d1 = fpArrivee && fpArrivee.selectedDates[0];
      var d2 = fpDepart && fpDepart.selectedDates[0];
      if (!d1 || !d2) {
        alert('Veuillez choisir les dates d\'arrivée et de départ.');
        return;
      }
      var dateArrivee = d1.toISOString().slice(0, 10);
      var dateDepart = d2.toISOString().slice(0, 10);
      var packInput = form.querySelector('input[name="pack"]:checked');
      var pack = packInput ? packInput.value : 'aucun';
      var nom = form.nom && form.nom.value ? form.nom.value.trim() : '';
      var email = form.email && form.email.value ? form.email.value.trim() : '';
      if (!nom || !email) {
        alert('Veuillez remplir nom et email.');
        return;
      }

      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Redirection vers le paiement…';
      }

      var payload = {
        date_arrivee: dateArrivee,
        date_depart: dateDepart,
        pack: pack,
        nom: nom,
        email: email,
        telephone: (form.telephone && form.telephone.value) ? form.telephone.value.trim() : '',
        message: (form.message && form.message.value) ? form.message.value.trim() : ''
      };

      var xhr = new XMLHttpRequest();
      xhr.open('POST', API_BASE + '/api/create-reservation', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = 'Payer et réserver';
        }
        if (xhr.status === 200) {
          var data;
          try {
            data = JSON.parse(xhr.responseText);
          } catch (err) {
            alert('Erreur de réponse du serveur.');
            return;
          }
          if (data.url) {
            window.location.href = data.url;
            return;
          }
        }
        if (xhr.status === 503) {
          var msg = 'Paiement non configuré côté serveur. Réservez par téléphone ou email en attendant.';
          try {
            var r = JSON.parse(xhr.responseText);
            if (r.message) msg = r.message;
          } catch (e) {}
          alert(msg);
          return;
        }
        var errMsg = 'Impossible de créer la réservation. Réessayez ou contactez-nous.';
        try {
          var r = JSON.parse(xhr.responseText);
          if (r.error) errMsg = r.error;
        } catch (e) {}
        alert(errMsg);
      };
      xhr.onerror = function () {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = 'Payer et réserver';
        }
        alert('Erreur de connexion. Vérifiez que le serveur tourne (npm start) et réessayez.');
      };
      xhr.send(JSON.stringify(payload));
    });
  }

  // Message succès / annulation
  var params = new URLSearchParams(window.location.search);
  if (params.get('success') === '1') {
    if (recapBlock) recapBlock.style.display = 'none';
    var sessionId = params.get('session_id');
    if (sessionId) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', API_BASE + '/api/confirm-session?session_id=' + encodeURIComponent(sessionId), true);
      xhr.onload = function () {
        var msg = 'Merci ! Votre réservation est confirmée. Un email de confirmation vous a été envoyé.';
        if (xhr.status !== 200) msg = 'Merci ! Votre réservation est confirmée.';
        alert(msg);
        window.history.replaceState({}, document.title, window.location.pathname);
      };
      xhr.onerror = function () {
        alert('Merci ! Votre réservation est confirmée. Vous recevrez un email de confirmation.');
        window.history.replaceState({}, document.title, window.location.pathname);
      };
      xhr.send();
    } else {
      alert('Merci ! Votre réservation est confirmée. Vous recevrez un email de confirmation.');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
  if (params.get('cancel') === '1') {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
})();
